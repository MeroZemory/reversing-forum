import {
  reportReasons,
  type ReportReason,
  type ReportFormState,
} from "@/contracts/reports";
import { Button } from "./ui/action";
export function ReportFormView({ state }: { state: ReportFormState }) {
  if (state.sent)
    return (
      <p role="status">
        접수했습니다. 운영자가 내용을 확인한 뒤 필요한 조치를 검토합니다.
      </p>
    );
  return (
    <form
      className="stack-form report-form"
      aria-busy={state.busy}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void state.submit(
          String(data.get("reason")) as ReportReason,
          String(data.get("detail")),
        );
      }}
    >
      <label>
        요청 사유
        <select name="reason" required disabled={state.busy}>
          {Object.entries(reportReasons).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        확인할 내용
        <textarea
          name="detail"
          required
          minLength={10}
          maxLength={2000}
          rows={7}
          readOnly={state.busy}
          aria-describedby="report-help"
        />
      </label>
      <p id="report-help" className="form-hint">
        문제가 있는 부분과 요청하는 조치를 알려 주세요. 원본 대화 전체나
        신분증은 보내지 않아도 됩니다.
      </p>
      <Button type="submit" disabled={state.busy}>
        {state.busy ? "접수 중…" : "운영자에게 보내기"}
      </Button>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
    </form>
  );
}
