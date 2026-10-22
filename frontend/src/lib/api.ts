import { authHeaders, getToken, handleUnauthorized } from "@/lib/token";

export type Level = "ok" | "review" | "empty";
export type FieldValue = string | string[] | null;

export const FIELD_NAMES = [
  "full_name",
  "id_number",
  "central_numbers",
  "receipt_date",
  "sender",
  "commitment_numbers",
  "test_type",
  "referral_number",
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
/** Not on every form: left empty, they never hold a form back. */
export const OPTIONAL_FIELDS: FieldName[] = ["test_type", "referral_number"];

export interface Reason {
  kind: string;
  code: string;
  /** A value the note quotes, e.g. the name an ID is already filed under (name_change). */
  detail?: string;
}

export interface FieldData {
  id: number;
  name: FieldName;
  value: FieldValue;
  level: Level;
  confidence: number;
  reasons: Reason[];
  manually_corrected: boolean;
  /** Normalized [x0, y0, x1, y1] of the value on the page image (fractions from the top-left). */
  box: [number, number, number, number] | null;
  box_verified?: boolean;
  /** What the model originally read (before any manual correction). */
  original: FieldValue;
  /** Bumped on every save; sent back with an edit so a stale edit is refused instead of overwriting. */
  version?: number;
}

export type Status = "pending" | "processing" | "done" | "failed";

export interface SourceFileData {
  id: number;
  filename: string;
  status: Status;
  progress: number;
  error: string | null;
  pages_total: number;
  pages_done: number;
  fields_total: number;
  fields_extracted: number;
  avg_confidence: number | null;
  /** Stable code of the failure (empty_file, corrupt_file, password_protected, ...), translated in the UI. */
  error_code?: string | null;
  /** The file was read, but something is off (pages_missing, file_repaired). */
  warnings?: string[];
  /** The same file was already uploaded in that batch. */
  duplicate_of_batch?: number | null;
}

/** What is on a page: only commitments (and their continuation pages) are read. */
export type DocType = "commitment" | "continuation" | "other_medical" | "unrelated" | "blank";
export const SKIPPED_DOC_TYPES: DocType[] = ["other_medical", "unrelated", "blank"];

export interface FormData {
  id: number;
  source_file_id: number;
  filename: string;
  page_index: number;
  status: Status;
  error: string | null;
  workflow: Workflow | null;
  assigned_to: number | null;
  approver_comment: string | null;
  error_code?: string | null;
  doc_type?: DocType;
  /** Form-level review codes (multiple_commitments, poor_quality, merged_pages, possible_duplicate...). */
  reasons?: string[];
  /** Set on a continuation page merged into another form (hidden behind it). */
  parent_form_id?: number | null;
  /** This form's own page first, then the pages merged into it. */
  page_ids?: number[];
  region_index?: number | null;
  started_at?: string | null;
  /** Shown for review already; the zoomed checks still run in the background. */
  refining?: boolean;
  /** Counts the times the page image was replaced (see api.imageUrl). */
  image_rev?: number;
  /** Patient file: normalized 9-digit ID and how the form was filed under it. */
  patient_id?: string | null;
  patient_link?: PatientLink | null;
  /** Light read of a non-commitment page (referral...). */
  doc_meta?: DocMeta | null;
  fields: Record<FieldName, FieldData | null>;
}

export type PatientLink = "auto" | "suggested" | "manual" | "rejected";

export interface DocMeta {
  id_number: string | null;
  id_confident?: boolean;
  full_name: string | null;
  doc_date: string | null;
  doc_kind: "referral" | "lab_result" | "letter" | "other";
  test_type: string | null;
  referral_number: string | null;
}

export interface BatchDetail {
  id: number;
  created_at: string;
  status: "processing" | "done";
  paused: boolean;
  files: SourceFileData[];
  forms: FormData[];
  counts: Record<Level, number>;
  failed_forms: number;
  skipped_forms?: number;
  /** A batch-wide problem, e.g. "api_unavailable" (the batch was paused). */
  notice?: string | null;
  expected_files?: number | null;
  /** Labels of `rule:<id>` reasons. */
  rule_names?: Record<string, string>;
}

export interface BatchSummary {
  id: number;
  created_at: string;
  status: string;
  files: number;
  forms: number;
}

export type ExportFormat = "xlsx" | "csv" | "json";

export interface ExportOptions {
  format: ExportFormat;
  include_details: boolean;
  include_source_links: boolean;
  password_protect: boolean;
}

export interface ExportFile {
  filename: string;
  size_bytes: number;
  sheets: number;
  rows: number;
  fields: number;
  /** null when the file is password protected (its checksum changes on every save). */
  sha256: string | null;
}

/** One preview row: field values plus the review state of the form. */
export type ExportRow = Record<string, FieldValue | number | undefined> & {
  _form_id: number;
  _review: number;
  _confidence: number | null;
};

export interface ConfidenceRow {
  filename: string;
  page: number;
  fields: Record<string, { level: Level; confidence: number; manually_corrected: boolean }>;
}

export interface ExportSummary {
  review: number;
  failed_forms: number;
  forms: number;
  /** Only approved forms are exported. */
  approved: number;
  unapproved: number;
  processing: boolean;
  files: number;
  pages: number;
  pages_done: number;
  source_formats: string[];
  fields: Record<Level, number>;
  avg_confidence: number | null;
  readable_pct: number;
  scan_number: string;
  processing_seconds: number | null;
  sheet_name: string;
  columns: { field: FieldName; header: string }[];
  preview: ExportRow[];
  confidence_preview: ConfidenceRow[];
  options: ExportOptions;
  file: ExportFile;
  last_export: { created_at: string; filename: string; size_bytes: number; sha256: string } | null;
}

// ---------- users, workflow, dashboards ----------

export type Role = "intake" | "approver" | "lab_manager" | "admin";
export type Workflow = "needs_fix" | "pending_approval" | "returned" | "approved";
export type BacklogState = "processing" | Workflow | "failed";
export type Stage = "processing" | "needs_fix" | "pending_approval" | "returned";
export type FlaggedFilter = "all" | "none" | "some" | "many";

export interface User {
  id: number;
  username: string;
  display_name: string;
  /** Primary role (the highest one held). */
  role: Role;
  /** Every role the user holds. */
  roles?: Role[];
  active?: boolean;
  created_at?: string | null;
  last_login_at?: string | null;
}

export interface RolesInfo {
  roles: Role[];
  permissions: Record<Role, string[]>;
}

// ---------- patient file ----------

export interface PatientSummary {
  patient_id: string;
  names: string[];
  /** A clerk approved a new name: older documents may carry the previous one. */
  name_changed?: boolean;
  commitments: number;
  documents: number;
  last_seen: string;
}

export interface PatientForm {
  id: number;
  batch_id: number;
  page_index: number;
  filename: string;
  doc_type: DocType;
  workflow: Workflow | null;
  patient_link: PatientLink | null;
  patient_id: string | null;
  created_at: string | null;
  fields: Partial<Record<FieldName, FieldValue>>;
  doc_meta: DocMeta | null;
}

export interface PatientFile {
  patient_id: string;
  names: string[];
  name_change?: { current: string; previous: string[]; at: string | null } | null;
  commitments: PatientForm[];
  documents: PatientForm[];
  suggested: PatientForm[];
  pending_approval: number;
}

// ---------- validation rules ----------

export type RuleOp = "eq" | "neq" | "in" | "contains" | "empty" | "not_empty";
export type RuleCheck = "required" | "forbidden" | "regex" | "in_list" | "date_not_before";

export interface RuleSpec {
  combine: "all" | "any";
  when: { field: FieldName; op: RuleOp; value?: unknown }[];
  then: { field: FieldName; check: RuleCheck; arg?: unknown };
}

export interface RuleExplain {
  description: string | null;
  parts: { conditions: string[]; joiner: string; action: string } | null;
}

export interface Rule extends RuleExplain {
  id: number;
  name: string;
  source_text: string;
  spec: RuleSpec;
  status: "draft" | "active" | "disabled";
  version: number;
  created_at: string | null;
  updated_at: string | null;
  last_dry_run: { checked: number; flagged: number; at: string } | null;
  flagged_open?: number;
}

export interface RuleParse extends RuleExplain {
  name: string;
  spec: RuleSpec | null;
  unknown_terms: string[];
  question: string | null;
  errors: string[];
}

export interface DryRun extends RuleExplain {
  checked: number;
  flagged: number;
  by_sender: Record<string, number>;
  field_coverage: Record<string, number>;
  warnings: { code: "field_never_read"; field: FieldName }[];
  examples: QueueForm[];
}

export interface QueueForm {
  id: number;
  batch_id: number;
  filename: string;
  page_index: number;
  workflow: Workflow;
  assigned_to: number | null;
  assigned_name: string | null;
  approver_comment: string | null;
  /** Fields not at level ok. */
  flagged: number;
  full_name: FieldValue;
  id_number: FieldValue;
  sender: FieldValue;
  waiting_since: string | null;
  changed_by: string | null;
}

export interface UploadRow {
  id: number;
  created_at: string;
  status: "processing" | "done";
  forms: number;
  done: number;
  failed: number;
  approved: number;
}

export interface WorkloadRow extends User {
  in_queue: number | null;
  handled_week: number;
}

export type MyQueue =
  | {
      role: "intake";
      forms: QueueForm[];
      uploads: UploadRow[];
      today: { received: number; corrected: number; submitted: number; waiting: number };
    }
  | {
      role: "approver";
      forms: QueueForm[];
      history: { form_id: number; batch_id: number | null; workflow: Workflow; at: string; comment: string | null }[];
      today: { approved: number; returned: number; waiting: number };
    }
  | { role: "lab_manager"; workload: WorkloadRow[] };

export interface DashAccuracy {
  accuracy: number | null;
  fields: number;
  approved_forms: number;
  by_day: { day: string; accuracy: number; fields: number }[];
}

export interface DashProblemFields {
  fields: { field: FieldName; corrections: number }[];
  senders: string[];
  cells: Record<FieldName, Record<string, number>>;
}

export interface DashTimeToApproval {
  avg_hours: number | null;
  forms: number;
  stages: { stage: Stage; avg_hours: number }[];
  by_day: ({ day: string; forms: number } & Record<Stage, number>)[];
}

/** The request never reached the server; the UI shows its own translated message. */
export class NetworkError extends Error {}

/** The server refused the request. `code` is set when the server sent a stable error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null = null,
    public data: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

/** FastAPI's `detail` is a string, or an object {code, detail, ...} for errors the UI handles itself. */
function toApiError(status: number, statusText: string, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    return new ApiError(String(d.detail ?? d.code ?? statusText), status, (d.code as string) ?? null, d);
  }
  return new ApiError(typeof detail === "string" ? detail : statusText, status);
}

async function failure(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return toApiError(res.status, res.statusText, body);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  } catch {
    throw new NetworkError("Network error");
  }
  if (res.status === 401 && !url.startsWith("/api/auth/login")) handleUnauthorized();
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

export interface UploadHandle {
  promise: Promise<{ id: number; status: Status; error_code: string | null; duplicate_of_batch: number | null }>;
  abort: () => void;
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  listBatches: () => request<BatchSummary[]>("/api/batches"),
  getBatch: (id: number) => request<BatchDetail>(`/api/batches/${id}`),
  deleteBatch: (id: number) => request<{ ok: boolean }>(`/api/batches/${id}`, { method: "DELETE" }),
  exportSummary: (id: number) => request<ExportSummary>(`/api/batches/${id}/export/summary`),
  saveExportOptions: (id: number, options: ExportOptions) =>
    request<{ options: ExportOptions; file: ExportFile }>(`/api/batches/${id}/export/options`, {
      method: "PUT",
      ...json(options),
    }),
  /** Builds the file on the server (options are read from the DB) and returns it as a Blob. */
  async downloadExport(id: number, password?: string): Promise<Blob> {
    const body = json({ password: password || null, link_base: window.location.origin });
    const res = await fetch(`/api/batches/${id}/export`, {
      method: "POST",
      ...body,
      headers: { ...authHeaders(), ...body.headers },
    });
    if (res.status === 401) handleUnauthorized();
    if (!res.ok) throw await failure(res);
    return res.blob();
  },
  /** <img src> cannot send headers, so the token rides in the query string. */
  /** rev: the page image is replaced when it is turned / straightened; a new rev is a new URL, so no stale copy. */
  imageUrl: (formId: number, rev = 0) => `/api/forms/${formId}/image?token=${encodeURIComponent(getToken() ?? "")}&rev=${rev}`,
  deleteForm: (formId: number) => request<{ ok: boolean }>(`/api/forms/${formId}`, { method: "DELETE" }),
  retryForm: (formId: number) => request<{ ok: boolean }>(`/api/forms/${formId}/retry`, { method: "POST" }),
  /** With `version`, an edit over a newer server value is refused (409, code "conflict"). */
  updateField: (fieldId: number, value: FieldValue, version?: number) =>
    request<FieldData>(`/api/fields/${fieldId}`, { method: "PATCH", ...json({ value, version }) }),
  setDocType: (formId: number, docType: DocType) =>
    request<{ ok: boolean }>(`/api/forms/${formId}/doc-type`, { method: "POST", ...json({ doc_type: docType }) }),
  mergePrevious: (formId: number) =>
    request<{ ok: boolean; parent_form_id: number }>(`/api/forms/${formId}/merge-previous`, { method: "POST" }),
  splitForm: (formId: number) =>
    request<{ ok: boolean; form_ids: number[] }>(`/api/forms/${formId}/split`, { method: "POST" }),
  retryFailed: (batchId: number) =>
    request<{ ok: boolean; forms: number[] }>(`/api/batches/${batchId}/retry-failed`, { method: "POST" }),
  openBatch: (expectedFiles: number) =>
    request<BatchDetail>("/api/batches/open", { method: "POST", ...json({ expected_files: expectedFiles }) }),
  closeBatch: (batchId: number) => request<BatchDetail>(`/api/batches/${batchId}/close`, { method: "POST" }),
  approveField: (fieldId: number) => request<FieldData>(`/api/fields/${fieldId}/approve`, { method: "POST" }),
  resetField: (fieldId: number) => request<FieldData>(`/api/fields/${fieldId}/reset`, { method: "POST" }),
  pauseBatch: (id: number) => request<{ ok: boolean }>(`/api/batches/${id}/pause`, { method: "POST" }),
  resumeBatch: (id: number) => request<{ ok: boolean }>(`/api/batches/${id}/resume`, { method: "POST" }),
  cancelBatch: (id: number) => request<{ ok: boolean }>(`/api/batches/${id}/cancel`, { method: "POST" }),
  senders: () => request<string[]>("/api/senders"),

  // Auth and approval workflow
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>("/api/auth/login", { method: "POST", ...json({ username, password }) }),
  me: () => request<User>("/api/auth/me"),
  myQueue: (flagged?: FlaggedFilter, role?: Role) => {
    const q = new URLSearchParams();
    if (flagged && flagged !== "all") q.set("flagged", flagged);
    if (role) q.set("role", role);
    const qs = q.toString();
    return request<MyQueue>(`/api/queue/me${qs ? `?${qs}` : ""}`);
  },
  submitForm: (formId: number) =>
    request<{ ok: boolean; workflow: Workflow; flagged: number }>(`/api/forms/${formId}/submit`, { method: "POST" }),
  approveForm: (formId: number) =>
    request<{ ok: boolean; workflow: Workflow }>(`/api/forms/${formId}/approve`, { method: "POST" }),
  returnForm: (formId: number, comment: string) =>
    request<{ ok: boolean; workflow: Workflow }>(`/api/forms/${formId}/return`, {
      method: "POST",
      ...json({ comment }),
    }),
  approveBulk: (ids: number[]) =>
    request<{ approved: number[]; skipped: number[] }>("/api/forms/approve-bulk", { method: "POST", ...json({ ids }) }),
  finalizeBatch: (batchId: number) =>
    request<{ approved: number[]; skipped: number[] }>(`/api/batches/${batchId}/finalize`, { method: "POST" }),
  assignForm: (formId: number, userId: number) =>
    request<{ ok: boolean }>(`/api/forms/${formId}/assign`, { method: "POST", ...json({ user_id: userId }) }),
  users: () => request<User[]>("/api/users"),
  intakeForms: () => request<QueueForm[]>("/api/forms/queue"),
  dashBacklog: () => request<{ states: { state: BacklogState; count: number }[] }>("/api/dashboard/backlog"),
  dashAccuracy: () => request<DashAccuracy>("/api/dashboard/accuracy"),
  dashProblemFields: () => request<DashProblemFields>("/api/dashboard/problem-fields"),
  dashTimeToApproval: () => request<DashTimeToApproval>("/api/dashboard/time-to-approval"),
  dashWorkload: () => request<WorkloadRow[]>("/api/dashboard/workload"),

  /** Server-sent events for a batch (EventSource cannot send headers: the token rides in the query). */
  batchEventsUrl: (batchId: number) =>
    `/api/batches/${batchId}/events?token=${encodeURIComponent(getToken() ?? "")}`,

  // User management (admin)
  adminUsers: (filters: { q?: string; role?: Role; active?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (filters.q) q.set("q", filters.q);
    if (filters.role) q.set("role", filters.role);
    if (filters.active !== undefined) q.set("active", String(filters.active));
    const qs = q.toString();
    return request<User[]>(`/api/admin/users${qs ? `?${qs}` : ""}`);
  },
  adminRoles: () => request<RolesInfo>("/api/admin/roles"),
  createUser: (body: { username: string; display_name: string; roles: Role[]; password: string }) =>
    request<User>("/api/admin/users", { method: "POST", ...json(body) }),
  updateUser: (id: number, body: { username?: string; display_name?: string; roles?: Role[]; active?: boolean }) =>
    request<User>(`/api/admin/users/${id}`, { method: "PATCH", ...json(body) }),
  resetPassword: (id: number, password: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/reset-password`, { method: "POST", ...json({ password }) }),
  deactivateUser: (id: number) => request<User>(`/api/admin/users/${id}`, { method: "DELETE" }),

  // Patient file
  searchPatients: (q: string) => request<PatientSummary[]>(`/api/patients?q=${encodeURIComponent(q)}`),
  patient: (pid: string) => request<PatientFile>(`/api/patients/${encodeURIComponent(pid)}`),
  linkPatient: (formId: number, action: "confirm" | "reject" | "set", patientId?: string) =>
    request<{ ok: boolean; patient_id: string | null; patient_link: PatientLink }>(`/api/forms/${formId}/patient`, {
      method: "POST",
      ...json({ action, patient_id: patientId }),
    }),

  // Validation rules
  rules: () => request<Rule[]>("/api/rules"),
  parseRule: (text: string) => request<RuleParse>("/api/rules/parse", { method: "POST", ...json({ text }) }),
  dryRunRule: (spec: RuleSpec) => request<DryRun>("/api/rules/dry-run", { method: "POST", ...json({ spec }) }),
  createRule: (body: { name: string; source_text: string; spec: RuleSpec }) =>
    request<Rule>("/api/rules", { method: "POST", ...json(body) }),
  activateRule: (id: number, applyOpen: boolean) =>
    request<Rule>(`/api/rules/${id}/activate`, { method: "POST", ...json({ apply_open: applyOpen }) }),
  disableRule: (id: number) => request<Rule>(`/api/rules/${id}/disable`, { method: "POST" }),

  /** One file into an open batch, with byte-level progress; abort() cancels it (e.g. a stalled upload). */
  uploadFile(batchId: number, file: File, onProgress: (fraction: number) => void): UploadHandle {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<Awaited<UploadHandle["promise"]>>((resolve, reject) => {
      const form = new window.FormData();
      form.append("file", file);
      xhr.open("POST", `/api/batches/${batchId}/files`);
      Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 401) handleUnauthorized();
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as Awaited<UploadHandle["promise"]>);
        else reject(toApiError(xhr.status, xhr.statusText, body));
      };
      xhr.onerror = () => reject(new NetworkError("Network error"));
      xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },

  /** Upload with byte-level progress (fetch has no upload progress). */
  uploadBatch(files: File[], onProgress: (fraction: number) => void): Promise<BatchDetail> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new window.FormData();
      files.forEach((f) => form.append("files", f));
      xhr.open("POST", "/api/batches");
      Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 401) handleUnauthorized();
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else {
          let detail = xhr.statusText;
          try {
            detail = JSON.parse(xhr.responseText).detail ?? detail;
          } catch {
            /* not JSON */
          }
          reject(new Error(detail));
        }
      };
      xhr.onerror = () => reject(new NetworkError("Network error"));
      xhr.send(form);
    });
  },
};
