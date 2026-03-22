import { useEffect, useRef, useState } from 'react'

export function ConfirmButton({
  children,
  onConfirm,
  className,
  confirmLabel = 'Confirm?',
  modalTitle,
  modalBody,
  ...rest
}: {
  children: React.ReactNode
  onConfirm: () => void
  className?: string
  confirmLabel?: string
  modalTitle?: string
  modalBody?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [confirming, setConfirming] = useState(false)
  const [showModal, setShowModal] = useState(false)
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
    onConfirm()
  }

  function handleModalCancel() {
    setShowModal(false)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  const title = modalTitle ?? (typeof children === 'string' ? children : 'Action')

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
            <div className="confirm-modal-actions">
              <button type="button" className="confirm-modal-cancel" onClick={handleModalCancel}>Cancel</button>
              <button type="button" className="confirm-modal-yes" onClick={handleModalConfirm}>Yes, proceed</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
