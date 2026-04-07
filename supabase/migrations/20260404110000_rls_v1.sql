ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own" ON users
  FOR ALL USING (auth.uid() = id);

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_members" ON orgs
  FOR ALL USING (
    id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

ALTER TABLE icp_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "icp_own_org" ON icp_profiles
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

ALTER TABLE push_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "push_log_own" ON push_log
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_keys_own" ON api_keys
  FOR ALL USING (
    org_id IN (
      SELECT org_id FROM users WHERE id = auth.uid()
    )
  );
