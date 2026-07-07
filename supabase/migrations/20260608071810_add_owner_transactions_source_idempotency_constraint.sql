ALTER TABLE owner_transactions
  ADD CONSTRAINT uq_owner_txn_source UNIQUE (source_reference_id, source);
