import { useEffect, useRef, useState } from 'react'

export function ConfirmButton({
  children,
  onConfirm,
  className,
  confirmLabel = 'Confirm?',
  modalTitle,
  modalBody,
  confirmPhrase,
  summaryItems = [],
  confirmButtonLabel = 'Yes, proceed',
  ...rest
}: {
  children: React.ReactNode
  onConfirm: () => void
  className?: string
  confirmLabel?: string
  modalTitle?: string
  modalBody?: string
  confirmPhrase?: string
  summaryItems?: string[]
  confirmButtonLabel?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [confirming, setConfirming] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [typedConfirmation, setTypedConfirmation] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  function handleClick() {
    if (confirming) {
      clearTimeout(timer.current)
      setConfirming(false)
      setShowModal(true)
    } else {
      setConfirming(true)
      timer.current = setTimeout(() => setConfirming(false), 3000)
    }
  }

  function handleModalConfirm() {
    setShowModal(false)
    setTypedConfirmation('')
    onConfirm()
  }

  function handleModalCancel() {
    setShowModal(false)
    setTypedConfirmation('')
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  const title = modalTitle ?? (typeof children === 'string' ? children : 'Action')
  const requiresTypedConfirmation = Boolean(confirmPhrase?.trim())
  const isTypedConfirmationValid = !requiresTypedConfirmation || typedConfirmation.trim() === confirmPhrase?.trim()

  return (
    <>
      <button
        {...rest}
        type="button"
        className={`${className ?? ''} ${confirming ? 'ec2-confirming' : ''}`}
        onClick={handleClick}
      >
        {confirming ? confirmLabel : children}
      </button>
      {showModal && (
        <div className="confirm-modal-overlay" onClick={handleModalCancel}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Are you sure?</h3>
            <p>{modalBody ?? `You are about to perform: ${title}. This action may not be reversible.`}</p>
            {summaryItems.length > 0 && (
              <div className="confirm-modal-summary">
                {summaryItems.map((item) => (
                  <div key={item} className="confirm-modal-summary-row">{item}</div>
                ))}
              </div>
            )}
            {requiresTypedConfirmation && (
              <label className="field">
                <span>Type <code>{confirmPhrase}</code> to continue</span>
                <input value={typedConfirmation} onChange={(event) => setTypedConfirmation(event.target.value)} autoFocus />
              </label>
            )}
            <div className="confirm-modal-actions">
              <button type="button" className="confirm-modal-cancel" onClick={handleModalCancel}>Cancel</button>
              <button type="button" className="confirm-modal-yes" onClick={handleModalConfirm} disabled={!isTypedConfirmationValid}>{confirmButtonLabel}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
