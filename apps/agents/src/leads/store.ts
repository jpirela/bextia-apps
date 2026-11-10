import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { lead, type LeadState } from "../db/schema.ts";

export type LeadRow = typeof lead.$inferSelect;

export class InvalidTransitionError extends Error {
  constructor(from: LeadState, to: LeadState) {
    super(`lead: transición inválida ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

const TRANSITIONS: Record<LeadState, LeadState[]> = {
  nuevo: ["respondido", "cualificado"],
  respondido: ["cualificando", "cualificado"],
  cualificando: ["cualificado"],
  cualificado: ["asignado"],
  asignado: ["entregado"],
  entregado: [],
};

export function canTransition(from: LeadState, to: LeadState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export async function findOrCreateLead(
  db: Db,
  input: { contactId: string; conversationId: string; mercado: string; fueraDeHorario: boolean },
): Promise<{ lead: LeadRow; created: boolean }> {
  const find = async () =>
    (await db.select().from(lead).where(eq(lead.conversation_id, input.conversationId)).limit(1))[0];
  const existing = await find();
  if (existing) return { lead: existing, created: false };
  const [created] = await db
    .insert(lead)
    .values({
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      mercado: input.mercado,
      fuera_de_horario: input.fueraDeHorario,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { lead: created, created: true };
  const again = await find();
  if (!again) throw new Error("lead: no se pudo crear ni encontrar");
  return { lead: again, created: false };
}

export async function saveLead(
  db: Db,
  current: LeadRow,
  patch: Partial<typeof lead.$inferInsert>,
): Promise<LeadRow> {
  const to = patch.estado as LeadState | undefined;
  if (to && !canTransition(current.estado, to)) throw new InvalidTransitionError(current.estado, to);
  const [row] = await db.update(lead).set(patch).where(eq(lead.id, current.id)).returning();
  return row;
}