// Local development scheduler. Production uses the authenticated Vercel cron endpoint.
const origin=process.env.APP_ORIGIN || 'http://127.0.0.1:3000';
if(!process.env.CRON_SECRET)throw Error('Configure CRON_SECRET in .env.');
console.log('Browser recording background worker started.');
while(true){
 try{const r=await fetch(new URL('/api/jobs/browser',origin),{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(60000)});if(!r.ok)console.log(`Background processing returned ${r.status}. Will retry.`);}catch{console.log('App unavailable. Background processing will retry.');}
 await new Promise(resolve=>setTimeout(resolve,30000));
}
