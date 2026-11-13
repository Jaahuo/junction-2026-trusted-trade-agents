import { discoverContexts } from "@app/server-kit";
import { serve } from "./server.ts";

await serve(await discoverContexts());
