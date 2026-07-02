# Team Members and Crew Members — Understanding the Difference

FieldStay has two distinct types of people on your account: team members who manage your operation from the dashboard, and crew members who do the hands-on work through the mobile app. They have different roles, different access, and different invitation flows.

---

## Team Members — Dashboard Access

Team members are the people who run operations alongside you: a co-owner, an operations manager, a bookkeeper, a property manager who handles a subset of your portfolio.

Team members log into the FieldStay dashboard at **app.fieldstay.app** using a standard email and password account. They access the same dashboard you do, with permissions determined by their role.

### Team Member Roles

| Role | What They Can Do |
|---|---|
| **Admin** | Full access including billing, member management, and all settings |
| **Manager** | Property and crew management, work orders, financials, reporting |
| **Viewer** | Read-only access to the dashboard — no edits, no assignments |

Most operations managers should be set as Manager. Viewers work well for property owners who want visibility into their portfolio's performance without being able to change anything.

### Inviting a Team Member

Go to **Settings → Team → Invite Member**, enter their email address, and select their role. They'll receive an invitation email with a link to create their FieldStay account. The link is valid for 7 days — if they don't accept in time, go back to Settings → Team and click **Resend Invite**.

Once they create their account and accept the invitation, they'll appear in your team list and have access to the dashboard with their assigned role.

---

## Crew Members — Mobile App Access

Crew members are the people doing the hands-on work: cleaners, restockers, maintenance helpers, turnover crew. They do not access the dashboard. Instead, they work exclusively through the FieldStay Crew App — a mobile app installed on their phone that shows their assigned turnovers, checklists, inventory counts, and work orders.

Crew members never see financial data, owner information, booking details beyond what they need for their assignments, or any other PM-side information.

### Inviting a Crew Member

Go to **Settings → Crew → Invite Crew Member**, enter their name and email address, and send the invite. They'll receive an email invitation to create their crew account.

After they accept the invite, share the crew app link with them:

```
https://app.fieldstay.app/crew
```

They'll log in with the account they just created. This is where they'll access everything — checklists, inventory counts, work orders, messages.

---

## Why Crew Members Must Install the App

This is the most important thing to communicate to your crew before their first turnover: **they need to install the FieldStay Crew App on their home screen, not just open it in a browser.**

The app is a Progressive Web App (PWA) — it installs directly from the browser, appears on their home screen like a native app, and works completely offline. The offline capability is what makes it work at remote properties without cell service. But offline mode only works if the app is properly installed, not just opened in a browser tab.

**If a crew member just opens the URL in Safari or Chrome without installing, they will lose their work when the browser tab closes or the screen goes to sleep.** This is the most common crew setup mistake and it shows up at the worst possible moment — mid-turnover with no signal.

### How to Install on iPhone (Safari Required)

Crew must use Safari on iPhone — not Chrome, not Firefox.

1. Open Safari and go to `app.fieldstay.app/crew`
2. Log in with their account
3. Tap the **Share** button (box with arrow pointing up, at the bottom)
4. Scroll down and tap **Add to Home Screen**
5. Tap **Add**

The FieldStay Crew Ops icon will appear on their home screen.

### How to Install on Android (Chrome)

1. Open Chrome and go to `app.fieldstay.app/crew`
2. Log in with their account
3. Tap the **three-dot menu** in the top right
4. Tap **Add to Home Screen** or **Install App**
5. Tap **Install**

### Enable Notifications When Prompted

The app will ask crew members to allow notifications after install. They should tap **Allow**. Notifications alert them the moment a new turnover or work order is assigned — without needing to open the app to check. If they miss the prompt, they can enable notifications later in their phone's Settings → Notifications → FieldStay.

### Confirming Installation Worked

A properly installed crew app will:
- Appear as a FieldStay icon on their home screen (not in their browser bookmarks)
- Open without a browser address bar at the top
- Show their assigned turnovers immediately after login
- Display a sync indicator when it's working through a connection backlog

---

## Summary — Who Gets What

| | Team Member | Crew Member |
|---|---|---|
| **Where they work** | Dashboard (app.fieldstay.app) | Crew App (app.fieldstay.app/crew) |
| **What they see** | Properties, bookings, financials, reports (based on role) | Their assigned turnovers, checklists, inventory, work orders |
| **How they're invited** | Settings → Team → Invite Member | Settings → Crew → Invite Crew Member |
| **Install required?** | No — just a browser login | Yes — PWA install on home screen required for offline use |
| **Notification permission** | Optional | Strongly recommended |

---

## Need Help?

Email **support@fieldstay.app** or use the chat widget in your dashboard.
