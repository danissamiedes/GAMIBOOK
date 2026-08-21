import { assertSafeKey, type StorageAdapter } from "./types";

/**
 * Any S3-compatible bucket (SPEC §13). The SDK is an optional dependency and is
 * imported lazily, so a local-disk deployment never pays for it.
 */
export class S3Adapter implements StorageAdapter {
  readonly name = "s3";

  constructor(
    private readonly bucket: string,
    private readonly config: {
      region?: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    },
  ) {}

  private clientPromise?: Promise<{
    client: { send: (command: unknown) => Promise<unknown> };
    commands: Record<string, new (input: unknown) => unknown>;
  }>;

  private async sdk() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const mod = (await import("@aws-sdk/client-s3")) as unknown as Record<string, never>;
        const S3Client = mod["S3Client"] as unknown as new (config: unknown) => {
          send: (command: unknown) => Promise<unknown>;
        };
        const client = new S3Client({
          region: this.config.region,
          endpoint: this.config.endpoint || undefined,
          forcePathStyle: this.config.forcePathStyle ?? false,
          credentials:
            this.config.accessKeyId && this.config.secretAccessKey
              ? {
                  accessKeyId: this.config.accessKeyId,
                  secretAccessKey: this.config.secretAccessKey,
                }
              : undefined,
        });
        return { client, commands: mod as unknown as Record<string, new (i: unknown) => unknown> };
      })();
    }
    return this.clientPromise;
  }

  async put(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<void> {
    assertSafeKey(key);
    const { client, commands } = await this.sdk();
    await client.send(
      new commands["PutObjectCommand"]({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const { client, commands } = await this.sdk();
    const result = (await client.send(
      new commands["GetObjectCommand"]({ Bucket: this.bucket, Key: key }),
    )) as { Body: { transformToByteArray: () => Promise<Uint8Array> } };
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const { client, commands } = await this.sdk();
    try {
      await client.send(new commands["HeadObjectCommand"]({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { client, commands } = await this.sdk();
    await client.send(new commands["DeleteObjectCommand"]({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const { client, commands } = await this.sdk();
    const result = (await client.send(
      new commands["ListObjectsV2Command"]({ Bucket: this.bucket, Prefix: prefix }),
    )) as { Contents?: { Key?: string }[] };
    return (result.Contents ?? []).map((o) => o.Key ?? "").filter(Boolean).sort();
  }
}
