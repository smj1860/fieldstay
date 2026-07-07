ALTER TABLE asset_type_standards
  ADD COLUMN age_weight       numeric NOT NULL DEFAULT 60
    CHECK (age_weight BETWEEN 30 AND 70),
  ADD COLUMN condition_weight numeric NOT NULL DEFAULT 40
    CHECK (condition_weight BETWEEN 30 AND 70),
  ADD COLUMN weight_updated_at timestamptz NULL;

ALTER TABLE asset_type_standards
  ADD CONSTRAINT asset_weights_sum_100
    CHECK (round(age_weight + condition_weight) = 100);
