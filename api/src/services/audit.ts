/* ============================================================
   Saturday — audit log
   Every admin mutation writes one row. Cheap, append-only, and
   queried straight back out for the admin panel's Audit tab.
   ============================================================ */
import { Env } from '../types';

export async function audit(env: Env, actorId: string, action: string, target?: string, detail?: unknown) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (id, actor_id, action, target, detail, created_at) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(
      crypto.randomUUID(), actorId, action, target ?? null,
      detail !== undefined ? JSON.stringify(detail).slice(0, 2000) : null,
      Date.now(),
    ).run();
  } catch (e) {
    // Auditing must never block the action it is recording.
    console.error('audit_log write failed', (e as Error).message);
  }
}
