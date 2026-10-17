// Map captured receipts to PayPal Disputes API evidence fields
// (POST /v1/customer/disputes/{id}/provide-evidence, evidence_type values below).
export function exportDisputePack(log) {
  const rs = log.receipts;
  const chain = log.verify();
  const items = rs.filter(r => r.paypal?.capture_id && ['ALLOW', 'APPROVED'].includes(r.decision)).map(r => {
    const origin = r.decision === 'APPROVED' ? rs.find(x => x.seq === r.context?.hold_seq) : r;
    return {
      receipt_seq: r.seq, receipt_hash: r.hash,
      paypal: { order_id: origin?.paypal?.order_id || null, capture_id: r.paypal.capture_id, authorization_id: r.paypal.authorization_id || null },
      evidence: [
        { evidence_type: 'PROOF_OF_AUTHORIZATION', notes: `Payment authorized by spend policy ${r.policy_hash.slice(0, 12)}…${r.decision === 'APPROVED' ? ' and explicitly approved by a human (' + r.context.approver + ')' : ''}. Ed25519-signed receipt #${r.seq}, hash ${r.hash}.`, documents: [{ name: `receipt-${r.seq}.json`, content: r }] },
        { evidence_type: 'MERCHANT_CUSTOMER_COMMUNICATIONS', notes: 'Agent transcript that led to the purchase request.', documents: [{ name: 'agent-transcript.json', content: origin?.context?.transcript || [] }] },
        { evidence_type: 'OTHER', notes: `Item description: ${r.request.quantity}x ${r.request.item} from ${r.request.merchant} for ${r.request.amount} ${r.request.currency}, ship to ${r.request.ship_to}. Gate verified quote "${origin?.evidence?.quote}" on ${origin?.evidence?.url} (page sha256 ${origin?.evidence?.page_sha256}).` },
      ],
    };
  });
  return { generated_at: new Date().toISOString(), gate_public_key: log.publicKeyPem, chain, items,
    submit_via: 'POST https://api-m.sandbox.paypal.com/v1/customer/disputes/{dispute_id}/provide-evidence (multipart: input JSON + files)' };
}
