import {onSchedule} from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import {sendEmail} from "../services/email"; // <-- adjust path if needed

admin.initializeApp();

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const BATCH_LIMIT = 450;
const PAGE_LIMIT = 1000;

// ---------- Utils ----------

type TimestampLike = { toMillis: () => number };

function isTimestampLike(v: unknown): v is TimestampLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "toMillis" in v &&
    typeof (v as Record<string, unknown>).toMillis === "function"
  );
}

function toMillis(v: unknown): number | null {
  if (isTimestampLike(v)) return v.toMillis();
  if (v instanceof Date) return v.getTime();

  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }

  return null;
}

type EmailJob = { to: string; subject: string; text: string };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- History updates ----------

async function closeOpenHistorySession(params: {
  historyCollection: string;
  idField: "student_id" | "tutor_id";
  userId: string;
  nowTs: admin.firestore.Timestamp;
}): Promise<void> {
  const db = admin.firestore();

  const snap = await db
    .collection(params.historyCollection)
    .where(params.idField, "==", params.userId)
    .where("time_out", "==", null)
    .limit(1)
    .get();

  if (snap.empty) return;

  await snap.docs[0].ref.set(
    {
      time_out: params.nowTs,
      last_sign_out: "auto",
    },
    {merge: true}
  );
}

// ---------- Main worker ----------

async function processCollection(collectionName: "students" | "tutors"):
  Promise<void> {
  const db = admin.firestore();
  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;

  let done = false;

  while (!done) {
    let q: admin.firestore.Query = db
      .collection(collectionName)
      .where("time_out", "==", null)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_LIMIT);

    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    let batch = db.batch();
    let ops = 0;

    const emailsToSend: EmailJob[] = [];
    const historyJobs: Array<Promise<void>> = [];

    const nowTs = admin.firestore.Timestamp.now();
    const nowMs = nowTs.toMillis();

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const timeInMs = toMillis(data.time_in);

      const hasLastSignOut = Object.prototype.hasOwnProperty.call(
        data, "last_sign_out");

      if (timeInMs == null) {
        // Ensure last_sign_out exists so UI
        // doesn't crash / assumptions stay consistent
        if (!hasLastSignOut) {
          batch.set(doc.ref, {last_sign_out: null}, {merge: true});
          ops++;
        }
      } else {
        const shouldAutoSignOut =
          data.time_out == null && nowMs - timeInMs >= EIGHT_HOURS_MS;

        if (shouldAutoSignOut) {
          // 1) Update main collection record
          batch.set(
            doc.ref,
            {time_out: nowTs, last_sign_out: "auto"},
            {merge: true}
          );
          ops++;

          // 2) Queue history update
          // (student_login_history / tutor_login_history)
          if (collectionName === "students") {
            historyJobs.push(
              closeOpenHistorySession({
                historyCollection: "student_login_history",
                idField: "student_id",
                userId: doc.id,
                nowTs,
              })
            );
          } else {
            historyJobs.push(
              closeOpenHistorySession({
                historyCollection: "tutor_login_history",
                idField: "tutor_id",
                userId: doc.id,
                nowTs,
              })
            );
          }

          // 3) Queue email (if email exists)
          const userEmail = typeof data.email === "string" ? data.email : "";
          if (userEmail) {
            emailsToSend.push({
              to: userEmail,
              subject: "Signed out successfully",
              text:
                "You were automatically signed out at " +
                `${nowTs.toDate().toLocaleString()}.`,
            });
          }
        } else if (!hasLastSignOut) {
          batch.set(doc.ref, {last_sign_out: null}, {merge: true});
          ops++;
        }
      }

      // Commit in chunks
      if (ops >= BATCH_LIMIT) {
        await batch.commit();

        // Run queued history updates AFTER commit
        for (const group of chunk(historyJobs, 25)) {
          await Promise.allSettled(group);
        }
        historyJobs.length = 0;

        // Send queued emails AFTER commit
        for (const e of emailsToSend) {
          await sendEmail(e);
        }
        emailsToSend.length = 0;

        batch = db.batch();
        ops = 0;
      }

      lastDoc = doc;
    }

    if (ops > 0) {
      await batch.commit();

      // Run remaining history updates AFTER commit
      for (const group of chunk(historyJobs, 25)) {
        await Promise.allSettled(group);
      }

      // Send remaining queued emails AFTER commit
      for (const e of emailsToSend) {
        await sendEmail(e);
      }
    }

    if (snap.size < PAGE_LIMIT) done = true;
  }
}

// ---------- Scheduled export ----------

export const autoSignOutDaily = onSchedule(
  {schedule: "every 24 hours", secrets: ["RESEND_API_KEY", "RESEND_FROM"]},
  async () => {
    await processCollection("students");
    await processCollection("tutors");
  }
);
