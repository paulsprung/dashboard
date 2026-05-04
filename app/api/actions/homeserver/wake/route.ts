import { NextResponse } from 'next/server';
import { requireUser, writeAudit } from '@/lib/auth';
import { env } from '@/lib/env';
import { wakeOnLan } from '@/lib/wol';
import { assertOrigin } from '@/lib/security';

export async function POST(req: Request) {
  try { assertOrigin(req); const user = await requireUser(['OWNER','ADMIN']); const { confirm } = await req.json(); if (confirm !== 'WAKE_HOMESERVER') return NextResponse.json({error:'Invalid confirm'},{status:400}); await wakeOnLan(env.homeserverMac); await writeAudit('homeserver.wake','SUCCESS',{userId:user.id,target:env.tailscaleHomeIP}); return NextResponse.json({ok:true}); }
  catch (e:any) { await writeAudit('homeserver.wake','FAILED',{metadata:{error:e.message}}); return NextResponse.json({error:e.message},{status:400}); }
}
