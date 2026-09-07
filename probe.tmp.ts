import 'dotenv/config'
import axios from 'axios'
const run = async () => {
  process.env.NODE_ENV = 'staging'
  const { generatePcToken } = await import('./src/controller/automation')
  const { access_token } = await generatePcToken('johnley00@gmail.com')
  const headers = { Authorization: `Bearer ${access_token}` }
  const B = 'https://api.planningcenteronline.com/giving/v2'
  const d = (await axios.get(`${B}/donations?per_page=1`, { headers })).data.data[0]
  // the to-one refund route exists even when empty; its error/meta reveals the resource shape
  for (const url of [`${B}/donations/${d.id}/refund`, `${B}/donations/${d.id}/refund?include=designation_refunds`]) {
    try {
      const r = await axios.get(url, { headers })
      console.log('GET', url.replace(B,''), '->', r.status, JSON.stringify(r.data).slice(0, 400))
    } catch (e: any) {
      console.log('GET', url.replace(B,''), '->', e?.response?.status, JSON.stringify(e?.response?.data).slice(0, 300))
    }
  }
  // PCO self-describes vertices: ask what attributes a Refund has
  try {
    const r = await axios.get(`${B}/donations/${d.id}/refund`, { headers, params: { 'fields[Refund]': 'amount_cents,fee_cents,refunded_at,created_at' } })
    console.log('fields probe ->', r.status)
  } catch (e: any) {
    console.log('fields probe ->', e?.response?.status, JSON.stringify(e?.response?.data?.errors?.[0]).slice(0, 300))
  }
}
run().then(()=>process.exit(0)).catch(e=>{ console.error('ERR', e?.response?.status, e.message); process.exit(1) })
