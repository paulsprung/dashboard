import { NextResponse } from 'next/server';
import { requireUser, writeAudit } from '@/lib/auth';
import { restartTeamSpeakContainer } from '@/lib/action-runner';
import { env } from '@/lib/env';
import { assertOrigin } from '@/lib/security';

export async function POST(req: Request) {
  try { assertOrigin(req); const user = await requireUser(['OWNER','ADMIN']); const { confirm } = await req.json(); if (confirm !== 'RESTART_TEAMSPEAK') return NextResponse.json({error:'Invalid confirm'},{status:400}); const result = await restartTeamSpeakContainer(env.tsContainerName); await writeAudit('teamspeak.restart','SUCCESS',{userId:user.id,target:env.tsContainerName,metadata:result}); return NextResponse.json(result); }
  catch (e:any) { await writeAudit('teamspeak.restart','FAILED',{metadata:{error:e.message}}); return NextResponse.json({error:e.message},{status:400}); }
}
