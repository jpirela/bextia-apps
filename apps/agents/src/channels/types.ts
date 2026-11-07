import type { Channel } from "../db/schema.ts";

export type { Channel };

export interface InboundMessage {
  channel: Channel;
  externalId: string;
  from: { phone?: string; email?: string; name?: string };
  text: string;
  subject?: string;
  market?: string;
  receivedAt: Date;
}

export interface OutboundMessage {
  channel: Channel;
  to: { phone?: string; email?: string };
  text: string;
  subject?: string;
}

export interface ChannelAdapter {
  readonly name: Channel;
  receive(req: Request): Promise<InboundMessage[]>;
  send(msg: OutboundMessage): Promise<{ externalId: string }>;
}
