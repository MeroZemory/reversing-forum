import type { ReportCommand } from "@/contracts/reports";
export async function sendReport(command: ReportCommand) {
  const response = await fetch("/api/reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok)
    throw new Error(
      (await response.json()).error ||
        "접수하지 못했습니다. 다시 시도해 주세요.",
    );
}
