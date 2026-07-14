-- Fix: messages_insert's WITH CHECK validated sender_id and org_id
-- membership, but never that recipient_id actually belongs to org_id.
-- Every current call site (sendMessageToCrew, sendMessageToPM,
-- sendGroupMessage in app/(dashboard)/messages/actions.ts) resolves
-- recipient_id server-side from an org-scoped lookup, so this wasn't
-- exploitable through any known UI path -- but there was no DB-level
-- backstop for a future client-supplied-recipient code path.

DROP POLICY IF EXISTS "messages_insert" ON public.messages;

CREATE POLICY "messages_insert" ON public.messages FOR INSERT
  WITH CHECK (
    (sender_id = (select auth.uid()))
    AND (
      (org_id IN (SELECT get_user_org_ids()))
      OR (org_id IN (SELECT crew_members.org_id FROM crew_members WHERE crew_members.user_id = (select auth.uid())))
    )
    AND (
      (recipient_id IN (
        SELECT organization_members.user_id FROM organization_members
        WHERE organization_members.org_id = messages.org_id
          AND organization_members.invite_accepted_at IS NOT NULL
      ))
      OR (recipient_id IN (
        SELECT crew_members.user_id FROM crew_members
        WHERE crew_members.org_id = messages.org_id
          AND crew_members.user_id IS NOT NULL
      ))
    )
  );
