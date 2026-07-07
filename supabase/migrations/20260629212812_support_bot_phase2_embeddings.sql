
-- ─────────────────────────────────────────────────────────────────────────────
-- Support bot Phase 2 — enable real embedding similarity search
-- ─────────────────────────────────────────────────────────────────────────────

-- HNSW index for fast cosine similarity search.
-- Deferred from Phase 1 scaffold until embeddings are populated.
-- vector_cosine_ops = cosine distance (matches 1 - (a <=> b) similarity).
CREATE INDEX IF NOT EXISTS support_kb_chunks_embedding_idx
  ON support_kb_chunks
  USING hnsw (embedding vector_cosine_ops);

-- RPC function called by retrieve.ts.
-- Takes a query embedding and returns the top N most similar chunks.
-- Filters out rows where embedding IS NULL (placeholder seed chunks).
CREATE OR REPLACE FUNCTION match_kb_chunks(
  query_embedding vector(1536),
  match_count     int DEFAULT 5,
  min_similarity  float DEFAULT 0.3
)
RETURNS TABLE (
  id          uuid,
  title       text,
  content     text,
  source      text,
  similarity  float
)
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
  SELECT
    id,
    title,
    content,
    source,
    1 - (embedding <=> query_embedding) AS similarity
  FROM support_kb_chunks
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) >= min_similarity
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Allow authenticated users to call the RPC
GRANT EXECUTE ON FUNCTION match_kb_chunks(vector, int, float) TO authenticated;
GRANT EXECUTE ON FUNCTION match_kb_chunks(vector, int, float) TO service_role;
