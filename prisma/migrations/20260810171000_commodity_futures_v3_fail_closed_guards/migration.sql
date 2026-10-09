CREATE OR REPLACE FUNCTION guard_commodity_contract_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_class='COMMODITY_FUTURES' AND (NEW.root_id IS NULL OR NEW.expiration IS NULL) THEN
    NEW.verification_status := 'PARTIAL';
    NEW.identity_state := 'PARTIAL';
    NEW.identity_reason := CASE WHEN NEW.root_id IS NULL THEN 'ROOT_LINK_CONFLICT' ELSE 'EXPIRATION_SOURCE_PENDING' END;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commodity_contract_identity_guard ON futures_contracts;
CREATE TRIGGER commodity_contract_identity_guard BEFORE INSERT OR UPDATE ON futures_contracts FOR EACH ROW EXECUTE FUNCTION guard_commodity_contract_identity();

CREATE OR REPLACE FUNCTION guard_verified_commodity_front() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verification_status='VERIFIED' AND NEW.selection_rule<>'NEAREST_NON_EXPIRED_VERIFIED_CONTRACT' THEN
    NEW.active_contract_id := OLD.active_contract_id;
    NEW.selection_rule := OLD.selection_rule;
    NEW.selection_date := OLD.selection_date;
    NEW.selection_reason := OLD.selection_reason;
    NEW.calculation_version := OLD.calculation_version;
    NEW.verification_status := OLD.verification_status;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS verified_commodity_front_guard ON futures_front_contracts;
CREATE TRIGGER verified_commodity_front_guard BEFORE UPDATE ON futures_front_contracts FOR EACH ROW EXECUTE FUNCTION guard_verified_commodity_front();
