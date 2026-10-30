import { useState, useId, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, apiError } from '../api'
import { Button, FormField, Icon, useToast } from './UI'
import { formatMoney } from '../lib'

export interface ManualRefundModalProps {
  isOpen: boolean
  onClose: () => void
  orderId: number
  shopifyOrderName: string
  suggestedAmount: number
  returnId?: number
  returnWaybill?: string
  customerName?: string
  onSuccess?: () => void
}

async function encodeFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function ManualRefundModal({
  isOpen,
  onClose,
  orderId,
  shopifyOrderName,
  suggestedAmount,
  returnId,
  returnWaybill,
  customerName,
  onSuccess,
}: ManualRefundModalProps) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const fileInputId = useId()

  const [amount, setAmount] = useState<string>(suggestedAmount > 0 ? String(suggestedAmount) : '')
  const [refundMode, setRefundMode] = useState<string>('UPI')
  const [accountUsed, setAccountUsed] = useState<string>('Current Account / UPI')
  const [externalReference, setExternalReference] = useState<string>('')
  const [note, setNote] = useState<string>('')
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null)
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null
    setEvidenceFile(file)
    if (evidencePreview) {
      URL.revokeObjectURL(evidencePreview)
    }
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      setEvidencePreview(url)
    } else {
      setEvidencePreview(null)
    }
  }

  const handleRemoveFile = () => {
    if (evidencePreview) {
      URL.revokeObjectURL(evidencePreview)
    }
    setEvidenceFile(null)
    setEvidencePreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  useEffect(() => {
    return () => {
      if (evidencePreview) {
        URL.revokeObjectURL(evidencePreview)
      }
    }
  }, [evidencePreview])

  const mutation = useMutation({
    mutationFn: async () => {
      const numericAmount = Number(amount)
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        throw new Error('Enter a valid refund amount greater than 0.')
      }
      if (!refundMode) {
        throw new Error('Select the refund payment mode (UPI, Bank Transfer, Cash).')
      }
      if (!accountUsed.trim()) {
        throw new Error('Enter the account or payout source used.')
      }
      const hasUtr = Boolean(externalReference.trim())
      const hasFile = Boolean(evidenceFile)
      if (!hasUtr && !hasFile) {
        throw new Error('Payment proof is required. Please provide either a Bank Reference / UTR number or upload a payment screenshot.')
      }
      if (evidenceFile && evidenceFile.size > 5 * 1024 * 1024) {
        throw new Error('Evidence file must be smaller than 5 MB.')
      }

      const evidence = evidenceFile
        ? {
            fileName: evidenceFile.name,
            contentType: evidenceFile.type || 'application/octet-stream',
            contentBase64: await encodeFileBase64(evidenceFile),
          }
        : undefined

      return (
        await api.post(`/api/orders/${orderId}/refunds/manual`, {
          amount: numericAmount,
          returnId,
          refundMode,
          accountUsed: accountUsed.trim(),
          externalReference: externalReference.trim() || undefined,
          note: note.trim() || undefined,
          evidence,
        })
      ).data
    },
    onSuccess: async () => {
      toast.toast('success', `Manual refund of ${formatMoney(Number(amount))} recorded successfully for ${shopifyOrderName}.`)
      await queryClient.invalidateQueries({ queryKey: ['returns'] })
      await queryClient.invalidateQueries({ queryKey: ['order', String(orderId)] })
      await queryClient.invalidateQueries({ queryKey: ['account-trail', orderId] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      onSuccess?.()
      onClose()
    },
    onError: (err) => {
      toast.toast('error', apiError(err))
    },
  })

  if (!isOpen) return null

  return (
    <div className="modal-backdrop" onClick={() => !mutation.isPending && onClose()}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Record Manual COD Refund"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '580px' }}
      >
        <div className="modal-header">
          <div className="modal-header-left">
            <div className="modal-icon-badge" style={{ background: '#fef3c7', color: '#b45309' }}>
              <Icon name="dollar" size={20} />
            </div>
            <div>
              <h3 className="modal-title">Record Manual COD Refund</h3>
              <p className="modal-desc">
                Log verified payment payout for order {shopifyOrderName}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="modal-order-summary-box">
            <div className="modal-order-summary-left">
              <span className="modal-order-name">
                {shopifyOrderName} {customerName ? `· ${customerName}` : ''}
              </span>
              <span className="modal-order-sub">
                COD Return {returnWaybill ? `· AWB ${returnWaybill}` : ''}
              </span>
            </div>
            <span className="modal-order-amount">{formatMoney(suggestedAmount)}</span>
          </div>

          <div
            style={{
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '12px',
              color: '#1e40af',
              lineHeight: 1.4,
            }}
          >
            <strong>COD Payment Guard:</strong> Because COD orders do not have an online gateway transaction in Shopify, funds must be remitted manually (via IMPS / NEFT / UPI). At least one proof of payment (<strong>Bank UTR</strong> or <strong>Payment Screenshot</strong>) is mandatory. Only one refund is allowed per order.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <FormField label="Refund Amount (₹)">
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
              />
            </FormField>

            <FormField label="Refund Mode">
              <select value={refundMode} onChange={(e) => setRefundMode(e.target.value)}>
                <option value="UPI">UPI (Google Pay / PhonePe / Paytm)</option>
                <option value="BANK_TRANSFER">Bank Transfer (IMPS / NEFT)</option>
                <option value="CASH">Cash</option>
                <option value="OTHER">Other</option>
              </select>
            </FormField>
          </div>

          <FormField label="Account / Payment Source Used">
            <input
              type="text"
              value={accountUsed}
              onChange={(e) => setAccountUsed(e.target.value)}
              placeholder="e.g. HDFC Current ··4821 or UPI ID"
              maxLength={160}
              required
            />
            <small style={{ fontSize: '11px', color: '#64748b' }}>
              Masked suffix or source name (do not enter full account numbers).
            </small>
          </FormField>

          <FormField label="Payment Reference (Bank UTR / Txn ID)">
            <input
              type="text"
              value={externalReference}
              onChange={(e) => setExternalReference(e.target.value)}
              placeholder="e.g. 429182910482 or UPI Ref"
              maxLength={160}
            />
            <small style={{ fontSize: '11px', color: '#64748b' }}>
              Provide UTR or upload payout screenshot below.
            </small>
          </FormField>

          <FormField label="Payout Proof Screenshot / Receipt">
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={handleFileChange}
              style={{ fontSize: '12px' }}
            />
            {evidenceFile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                <span style={{ fontSize: '12px', color: '#15803d', fontWeight: 600 }}>
                  ✓ {evidenceFile.name} ({(evidenceFile.size / 1024).toFixed(1)} KB)
                </span>
                <button
                  type="button"
                  onClick={handleRemoveFile}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#dc2626',
                    fontSize: '11px',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Remove
                </button>
              </div>
            )}
            {evidencePreview && (
              <div style={{ marginTop: '6px' }}>
                <img
                  src={evidencePreview}
                  alt="Proof preview"
                  style={{ maxHeight: '100px', borderRadius: '4px', border: '1px solid var(--line)' }}
                />
              </div>
            )}
          </FormField>

          <FormField label="Internal Note (Optional)">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Notes for auditor or customer support"
              maxLength={1000}
            />
          </FormField>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '14px' }}>
          <Button
            type="button"
            className="button-secondary"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="button-primary"
            style={{ background: '#b45309', borderColor: '#b45309', color: '#fff' }}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <Icon name="check" size={16} />
            Confirm & Record Refund
          </Button>
        </div>
      </div>
    </div>
  )
}
