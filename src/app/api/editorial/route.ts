import { editorialCollectionAction } from "@/server/editorial";
import { checkOrigin, failure, json, readJson } from "@/server/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    return json(await editorialCollectionAction(await readJson(request)));
  } catch (error) {
    return failure(error);
  }
}
