import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  /* config options here */
};

// withWorkflow enables the "use workflow" / "use step" directives (Workflow SDK) and generates
// the durable-execution routes under app/.well-known/workflow/** — required for
// app/api/workflows/bootstrap's start() calls to have a compiled workflow artifact to invoke.
export default withWorkflow(nextConfig);
