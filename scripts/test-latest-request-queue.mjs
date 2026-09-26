import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server=await createServer({server:{middlewareMode:true,watch:null},appType:'custom'})
try {
  const {createLatestRequestQueue}=await server.ssrLoadModule('/src/lib/latestRequestQueue.ts')
  const calls=[]
  const queue=createLatestRequestQueue(value=>new Promise((resolve,reject)=>calls.push({value,resolve,reject})),()=>[])
  const a=queue.read([1]), b=queue.read([2]), c=queue.read([3])
  assert.deepEqual(await b,[]);assert.equal(calls.length,1,'only one IPC request while the first is pending')
  calls[0].resolve(['one']);assert.deepEqual(await a,['one'])
  assert.equal(calls.length,2);assert.deepEqual(calls[1].value,[3],'obsolete page never reaches the backend')
  calls[1].reject(new Error('offline'));await assert.rejects(c,/offline/)
  const d=queue.read([4]), e=queue.read([5]);queue.dispose()
  assert.deepEqual(await e,[]);calls[2].resolve(['late']);assert.deepEqual(await d,[])
  assert.deepEqual(await queue.read([6]),[]);assert.equal(calls.length,3)
  console.log('PASS latest-page flags queue: one active request, replaced pages skipped, failure recovery and disposal')
} finally {await server.close()}
