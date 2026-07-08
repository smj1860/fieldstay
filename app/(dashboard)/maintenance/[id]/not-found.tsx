import Link from 'next/link'
import { Card } from '@/components/ui/Card'

export default function NotFound() {
  return (
    <Card className="text-center py-12">
      <p className="text-primary-themed font-semibold mb-1">We couldn&apos;t find that.</p>
      <p className="text-muted-themed text-sm mb-4">It may have been moved or deleted.</p>
      <Link href="/ops" className="btn-primary">Back to dashboard</Link>
    </Card>
  )
}
