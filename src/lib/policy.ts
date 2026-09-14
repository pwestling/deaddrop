import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors";

export interface Principal {
  id: string;
  name: string;
  owner: boolean;
  scopes: string[];
  spaces: string[] | null;
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function mintToken() {
  const token = `dd_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hash(token), prefix: token.slice(0, 11) };
}
export function requireScope(principal: Principal, scope: string) {
  if (!principal.scopes.includes(scope))
    throw new AppError(
      403,
      "insufficient_scope",
      `This connection needs ${scope}.`,
    );
}
export function requireSpace(principal: Principal, space: string) {
  if (principal.spaces && !principal.spaces.includes(space))
    throw new AppError(404, "not_found", "Space or drop not found.");
}
