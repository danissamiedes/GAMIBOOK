import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both of these load native binaries — a .node addon for argon2, a query
  // engine for Prisma — which the bundler cannot follow into. Leaving them
  // external means the files are traced and copied rather than inlined, which
  // is the difference between a working login and "Cannot find module" on a
  // serverless host.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client", ".prisma/client"],

  redirects() {
    return [
      {
        // Paying a consultant moved when work orders stopped being payables
        // in their own right (SPEC §8.1b): it is their bills that get paid,
        // and the screen went with them. Redirected rather than left to 404,
        // because this address worked yesterday and somebody has it
        // bookmarked. Without it the path falls through to /work-orders/[id]
        // and reads as a missing work order, which explains nothing.
        source: "/work-orders/pay",
        destination: "/consultant-bills/pay",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
