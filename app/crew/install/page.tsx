import { Metadata } from 'next'
import { CrewInstallClient } from './crew-install-client'

export const metadata: Metadata = {
  title: 'Install FieldStay — Crew App',
  description: 'Add FieldStay to your home screen for quick access to your assignments.',
}

export default function CrewInstallPage() {
  return <CrewInstallClient />
}
