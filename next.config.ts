import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both of these load native binaries — a .node addon for argon2, a query
  // engine for Prisma — which the bundler cannot follow into. Leaving them
  // external means the files are traced and copied rather than inlined, which
  // is the difference between a working login and "Cannot find module" on a
  // serverless host.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", ".prisma/client"],
};

export default nextConfig;
