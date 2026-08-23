import 'dotenv/config'
import { getQboTokensForUser } from './src/services/qboClient'
import quickBookApi from './src/utils/quickBookApi'

const run = async () => {
  const qb: any = quickBookApi(await getQboTokensForUser('johnley00@gmail.com'))
  const rows: any = await new Promise((res, rej) =>
    qb.findJournalEntries({ TxnDate: '2026-08-23' }, (e:any,d:any)=> e?rej(e):res(d)))
  const jes = rows?.QueryResponse?.JournalEntry ?? []
  let C=0, D=0
  console.log('\n=== QuickBooks entries dated 2026-08-23 ===')
  for (const je of jes) {
    console.log(`\nJE ${je.Id}  "${je.PrivateNote}"`)
    for (const l of je.Line) {
      const d = l.JournalEntryLineDetail
      console.log(`   ${d.PostingType.padEnd(6)} ${String(d.AccountRef?.name ?? d.AccountRef?.value).padEnd(34)} $${l.Amount.toFixed(2)}`)
      if (d.PostingType === 'Credit') C += l.Amount; else D += l.Amount
    }
  }
  console.log(`\n  combined credits $${C.toFixed(2)}   combined debits $${D.toFixed(2)}   balanced: ${Math.abs(C-D)<0.005}`)
}
run().then(()=>process.exit(0)).catch(e=>{ console.error('ERR', e.message); process.exit(1) })
