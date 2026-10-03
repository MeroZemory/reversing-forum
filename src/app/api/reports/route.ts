import { submitReport } from "@/server/reports";
import { checkOrigin, readJson, json, failure } from "@/server/http";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    return json(await submitReport(await readJson(request)), 201);
  } catch (error) {
    return failure(error);
  }
}
