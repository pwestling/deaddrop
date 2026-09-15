import { getAuth } from "@/lib/auth";
import { handleNamedConsent } from "@/lib/oauth-identities";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return getAuth().handler(request);
}
export async function POST(request: Request) {
  return handleNamedConsent(request, (incoming) => getAuth().handler(incoming));
}
