import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { api, type BacklogState, type FormData, type Role } from "@/lib/api";
import { errorText, workflowLabel } from "@/lib/labels";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";

const TONE: Record<BacklogState, "neutral" | "success" | "review" | "processing" | "danger"> = {
  processing: "processing",
  needs_fix: "neutral",
  pending_approval: "neutral",
  returned: "review",
  approved: "success",
  failed: "danger",
};

export function WorkflowChip({ state }: { state: BacklogState | null }) {
  const { t } = useI18n();
  if (!state) return null;
  return <Badge tone={TONE[state]}>{workflowLabel(t, state)}</Badge>;
}

/** Approver: return a form to the intake clerk with a required note. */
export function ReturnDialog({
  open,
  onOpenChange,
  subject,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject?: string;
  onConfirm: (comment: string) => Promise<void> | void;
}) {
  const { t, dir } = useI18n();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setComment("");
  }, [open]);

  async function confirm() {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await onConfirm(comment.trim());
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <DialogPrimitive.Content
          dir={dir}
          className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border-t-[3px] border-tertiary bg-white p-6 shadow-[0_14px_34px_-6px_rgba(184,11,96,0.10)]"
        >
          <DialogPrimitive.Title className="font-headline-md text-headline-md font-bold text-navy">
            {t("approvals.returnTitle")}
          </DialogPrimitive.Title>
          {subject && (
            <DialogPrimitive.Description className="mt-1 font-body-md text-body-md text-on-surface-variant" dir="auto">
              {subject}
            </DialogPrimitive.Description>
          )}
          <label className="mt-4 flex flex-col gap-1.5">
            <span className="font-label-md text-label-md text-navy">{t("approvals.returnLabel")}</span>
            <Textarea
              autoFocus
              dir="auto"
              value={comment}
              placeholder={t("approvals.returnPlaceholder")}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) confirm();
              }}
            />
          </label>
          <div className="mt-6 flex justify-start gap-2">
            <Button
              className="bg-tertiary hover:bg-[#9a0950] text-on-tertiary"
              disabled={!comment.trim() || busy}
              onClick={confirm}
            >
              {t("approvals.returnConfirm")}
            </Button>
            <DialogPrimitive.Close asChild>
              <Button variant="outline">{t("common.cancel")}</Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Per-form approval actions on the review screen: the clerk submits, the approver approves or returns. */
export function FormWorkflowBar({
  form,
  roles,
  flagged,
  onDone,
  onError,
}: {
  form: FormData;
  roles: Role[];
  /** Fields of this form not at level ok. */
  flagged: number;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [returning, setReturning] = useState(false);
  const [busy, setBusy] = useState(false);
  const wf = form.workflow;
  if (form.status !== "done" || !wf) return null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      onError(errorText(t, (e as { code?: string | null }).code, (e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const can = (...r: Role[]) => roles.some((x) => r.includes(x));
  const canSubmit = can("intake", "lab_manager") && (wf === "needs_fix" || wf === "returned");
  const canDecide = can("approver", "lab_manager") && wf === "pending_approval";
  const submit = () => run(() => api.submitForm(form.id));

  return (
    <div className="bg-surface-container-lowest rounded-xl p-3 shadow-md flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-label-md text-label-md text-on-surface-variant">{t("review.wfStatus")}</span>
          <WorkflowChip state={wf} />
          {!can("intake", "lab_manager") && <Badge tone="neutral">{t("review.wfReadOnly")}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {canSubmit && (
            <Button size="sm" disabled={busy} onClick={() => (flagged > 0 ? setConfirmSubmit(true) : submit())}>
              <span className="material-symbols-outlined text-[18px]">send</span>
              {t("review.wfSubmit")}
            </Button>
          )}
          {canDecide && (
            <>
              <Button size="sm" disabled={busy} onClick={() => run(() => api.approveForm(form.id))}>
                <span className="material-symbols-outlined text-[18px]">verified</span>
                {t("review.wfApprove")}
              </Button>
              <Button size="sm" variant="ghost" className="text-tertiary" disabled={busy} onClick={() => setReturning(true)}>
                {t("review.wfReturn")}
              </Button>
            </>
          )}
        </div>
      </div>
      {wf === "returned" && form.approver_comment && (
        <div className="border-s-4 border-tertiary bg-review/60 rounded-lg px-3 py-1.5 font-body-md text-body-md text-review-ink" dir="auto">
          <span className="font-bold">{t("review.wfReturnedNote")} </span>
          {form.approver_comment}
        </div>
      )}
      <ConfirmDialog
        open={confirmSubmit}
        onOpenChange={setConfirmSubmit}
        title={t("review.wfSubmit")}
        description={t("review.wfSubmitFlagged", { count: flagged })}
        confirmLabel={t("review.wfSubmit")}
        onConfirm={submit}
      />
      <ReturnDialog
        open={returning}
        onOpenChange={setReturning}
        subject={`${form.filename} · ${t("queue.page", { page: form.page_index + 1 })}`}
        onConfirm={(comment) => run(() => api.returnForm(form.id, comment))}
      />
    </div>
  );
}
