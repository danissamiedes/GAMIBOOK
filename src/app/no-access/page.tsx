import { Alert, Card } from "@/components/ui";

export default function NoAccessPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <Card>
        <Alert tone="warning">
          Your account is not a member of any company yet. Ask an owner to invite you.
        </Alert>
      </Card>
    </main>
  );
}
