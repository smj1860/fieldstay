'use client'

import Script from 'next/script'
import { useEffect } from 'react'

// Extend window type so TypeScript doesn't complain about Crisp globals
declare global {
  interface Window {
    $crisp:           Array<[string, string, unknown[]?]>
    CRISP_WEBSITE_ID: string
  }
}

interface CrispWidgetProps {
  userEmail: string
  userName?: string
  orgName?:  string
}

export function CrispWidget({ userEmail, userName, orgName }: CrispWidgetProps) {
  const websiteId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID

  useEffect(() => {
    if (!websiteId) return

    const identify = () => {
      if (typeof window === 'undefined' || !window.$crisp) return

      window.$crisp.push(['set', 'user:email', [userEmail]])

      if (userName) {
        window.$crisp.push(['set', 'user:nickname', [userName]])
      }

      if (orgName) {
        // Surfaces the organization name in the Crisp inbox conversation view
        window.$crisp.push(['set', 'session:data', [[['organization', orgName]]]])
      }
    }

    // Crisp may already be initialized if the user navigated between pages
    if (window.$crisp) {
      identify()
    } else {
      window.addEventListener('crisp:ready', identify, { once: true })
    }

    return () => {
      window.removeEventListener('crisp:ready', identify)
    }
  }, [websiteId, userEmail, userName, orgName])

  // Bail silently — no widget, no error
  if (!websiteId) return null

  return (
    <Script
      id="crisp-widget"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `
          window.$crisp = [];
          window.CRISP_WEBSITE_ID = "${websiteId}";
          (function() {
            var d = document;
            var s = d.createElement("script");
            s.src = "https://client.crisp.chat/l.js";
            s.async = 1;
            d.getElementsByTagName("head")[0].appendChild(s);
          })();
        `,
      }}
    />
  )
}
