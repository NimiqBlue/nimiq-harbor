import { http } from 'viem';

// Public Polygon RPCs impose traffic limits. A snapshot used to burst eight
// same-block reads at once, including after irreversible permit exposure.
// Share one bounded first-attempt queue across clients in this process. This
// never retries a read, changes its block tag, or touches provider dispatch.
const READ_INTERVAL_MS=250;
const MAX_QUEUED_READS=32;
const MAX_QUEUE_WAIT_MS=10_000;

export function createReadQueue(
  intervalMs=READ_INTERVAL_MS,
  clock:()=>number=()=>performance.now(),
  sleep:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
) {
  let tail=Promise.resolve(),pending=0,lastStarted=-Infinity;
  return async function queued<T>(read:()=>Promise<T>,signal?:AbortSignal|null):Promise<T> {
    if(pending>=MAX_QUEUED_READS)throw new Error('Polygon read queue unavailable');
    const entered=clock();pending++;
    const start=tail.then(async()=>{
      const delay=Math.max(0,intervalMs-(clock()-lastStarted));
      if(clock()-entered+delay>MAX_QUEUE_WAIT_MS)throw new Error('Polygon read queue unavailable');
      if(delay)await sleep(delay);
      if(signal?.aborted || clock()-entered>MAX_QUEUE_WAIT_MS)throw new Error('Polygon read queue unavailable');
      lastStarted=clock();
    });
    // Release the queue at dispatch, not on response completion. A slow read
    // must not stall unrelated first attempts or hide their freshness checks.
    tail=start.catch(()=>{});
    try {await start;return await read();}finally{pending--;}
  };
}
const queuedRead=createReadQueue();
export function polygonReadTransport(url:string) {
  return http(url,{
    timeout:10_000,retryCount:0,
    fetchFn:(input,init)=>queuedRead(()=>fetch(input,init),init?.signal),
  });
}
