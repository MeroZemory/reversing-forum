import { editorialAction, getEditorial } from "@/server/editorial";
import { checkOrigin, failure, json, readJson } from "@/server/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    return json(await getEditorial((await context.params).id));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    return json(
      await editorialAction((await context.params).id, await readJson(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
