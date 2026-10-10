-- 20261004000037_campaign_delete.sql
-- SAFE / additive. An admin can DELETE a campaign. Deleting archives it, as everywhere else in the Admin page: nothing is removed from the database. The campaign leaves the Admin list and
-- the website for good, and every free wash already claimed, every booking and every welcome offer stays exactly as it was.
--
--   campaigns.archived_at              set when a campaign is deleted
--   admin_archive_campaign(id)         the delete: switches it off and archives it (audited as campaign_deleted, with how many claims it had)
--   a trigger on campaigns             an archived campaign can never be switched on or edited again (so a deleted campaign cannot come back by accident); its code stays taken
-- A deleted campaign is already off (is_active = false), so get_campaign_status and claim_campaign_wash ignore it without any change to them.

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_campaigns_not_archived ON public.campaigns (created_at DESC) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.admin_archive_campaign(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text;
  v_claims integer;
BEGIN
  PERFORM app_private.require_admin();
  UPDATE public.campaigns SET is_active = false, archived_at = now(), updated_at = now()
   WHERE id = p_id AND archived_at IS NULL RETURNING code INTO v_code;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Campaign not found'; END IF;
  SELECT count(*) INTO v_claims FROM public.campaign_claims WHERE campaign_id = p_id AND status <> 'released';
  PERFORM app_private.audit('campaign', p_id, 'campaign_deleted', jsonb_build_object('code', v_code, 'claims', v_claims));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_archive_campaign(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_archive_campaign(uuid) TO authenticated; -- is_admin() inside

-- Once archived, a campaign stays as it is: it cannot be switched on, restored or edited.
CREATE OR REPLACE FUNCTION app_private.campaign_stay_archived() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- (an update that changes nothing, such as switching an already-off campaign off, is let through)
  IF OLD.archived_at IS NOT NULL
     AND (NEW.is_active OR NEW.archived_at IS DISTINCT FROM OLD.archived_at OR (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')) THEN
    RAISE EXCEPTION 'This campaign was deleted';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.campaign_stay_archived() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS campaigns_stay_archived ON public.campaigns;
CREATE TRIGGER campaigns_stay_archived BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION app_private.campaign_stay_archived();
