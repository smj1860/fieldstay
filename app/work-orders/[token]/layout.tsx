import { RegisterServiceWorker } from './register-service-worker'

export default function WorkOrderPortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="theme-locked-light-passive-dark">
      <RegisterServiceWorker />
      {children}
    </div>
  )
}
