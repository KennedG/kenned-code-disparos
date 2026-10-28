-- Schema-only fixture from the existing application schema 8; contains no user records.
CREATE TABLE alert_recipients(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE alerts(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE audit(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE automation_outbound(id TEXT PRIMARY KEY,at INTEGER NOT NULL,storageMode TEXT NOT NULL,kind TEXT);
CREATE TABLE buscas_authorizations(
      id TEXT PRIMARY KEY,principalId TEXT,active INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_authorizations_simulation(
      id TEXT PRIMARY KEY,principalId TEXT,active INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_deliveries(
      id TEXT PRIMARY KEY,runId TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,
      messageId TEXT,nextAttemptAt INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE buscas_deliveries_simulation(
      id TEXT PRIMARY KEY,runId TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,
      messageId TEXT,nextAttemptAt INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE buscas_gaps(
      id TEXT PRIMARY KEY,startedAt INTEGER NOT NULL,endedAt INTEGER,chatId TEXT,data TEXT NOT NULL);
CREATE TABLE buscas_gaps_simulation(
      id TEXT PRIMARY KEY,startedAt INTEGER NOT NULL,endedAt INTEGER,chatId TEXT,data TEXT NOT NULL);
CREATE TABLE buscas_history(
      id TEXT PRIMARY KEY,userId TEXT,chatId TEXT,createdAt INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_history_simulation(
      id TEXT PRIMARY KEY,userId TEXT,chatId TEXT,createdAt INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_inbox(
      id TEXT PRIMARY KEY,status TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_inbox_simulation(
      id TEXT PRIMARY KEY,status TEXT NOT NULL,createdAt INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_isolation_meta(id TEXT PRIMARY KEY);
CREATE TABLE buscas_messages(
      chatId TEXT NOT NULL,messageId TEXT NOT NULL,originalAt INTEGER NOT NULL,
      capturedAt INTEGER NOT NULL,revisionAt INTEGER NOT NULL,deletedAt INTEGER,
      senderId TEXT,forwarded INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,
      PRIMARY KEY(chatId,messageId));
CREATE TABLE buscas_messages_simulation(
      chatId TEXT NOT NULL,messageId TEXT NOT NULL,originalAt INTEGER NOT NULL,
      capturedAt INTEGER NOT NULL,revisionAt INTEGER NOT NULL,deletedAt INTEGER,
      senderId TEXT,forwarded INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,
      PRIMARY KEY(chatId,messageId));
CREATE TABLE buscas_offers(
      id TEXT PRIMARY KEY,chatId TEXT NOT NULL,messageId TEXT NOT NULL,messageAt INTEGER NOT NULL,
      supplierKey TEXT,modelKey TEXT,storageGB INTEGER,colorKey TEXT,condition TEXT,
      batteryPercent INTEGER,priceCents INTEGER,priceKind TEXT,confidence TEXT NOT NULL,
      status TEXT NOT NULL,productKey TEXT,fingerprint TEXT,data TEXT NOT NULL);
CREATE TABLE buscas_offers_simulation(
      id TEXT PRIMARY KEY,chatId TEXT NOT NULL,messageId TEXT NOT NULL,messageAt INTEGER NOT NULL,
      supplierKey TEXT,modelKey TEXT,storageGB INTEGER,colorKey TEXT,condition TEXT,
      batteryPercent INTEGER,priceCents INTEGER,priceKind TEXT,confidence TEXT NOT NULL,
      status TEXT NOT NULL,productKey TEXT,fingerprint TEXT,data TEXT NOT NULL);
CREATE TABLE buscas_runs(
      id TEXT PRIMARY KEY,chatId TEXT,messageId TEXT,userId TEXT,createdAt INTEGER NOT NULL,
      status TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE buscas_runs_simulation(
      id TEXT PRIMARY KEY,chatId TEXT,messageId TEXT,userId TEXT,createdAt INTEGER NOT NULL,
      status TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE buyer_demands(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE campaigns(id TEXT PRIMARY KEY,data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE cash_movements(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE cash_sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE commerce_deliveries(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE commerce_matches(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE commercial_lists(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE contact_categories(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE contact_intake_events(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE contact_pending(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE contacts(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE daily_reports(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE diagnostics(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE group_progress(campaignId TEXT NOT NULL,groupId TEXT NOT NULL,lastAt INTEGER NOT NULL,roundCount INTEGER NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp',PRIMARY KEY(campaignId,groupId));
CREATE TABLE group_rounds(campaignId TEXT NOT NULL,groupId TEXT NOT NULL,roundId TEXT NOT NULL,startedAt INTEGER NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp',PRIMARY KEY(campaignId,groupId,roundId));
CREATE TABLE groups_data(id TEXT PRIMARY KEY,data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE history(id TEXT PRIMARY KEY,category TEXT NOT NULL,sourceId TEXT NOT NULL,campaignId TEXT,userId TEXT,createdAt INTEGER NOT NULL,status TEXT,data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp',UNIQUE(category,sourceId));
CREATE TABLE inventory(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE jobs(id TEXT PRIMARY KEY,roundId TEXT NOT NULL,campaignId TEXT NOT NULL,groupId TEXT NOT NULL,itemId TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL, createdAt INTEGER, firstAttemptAt INTEGER, resultAt INTEGER, attempts INTEGER NOT NULL DEFAULT 0, messageId TEXT, dayKey TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp',UNIQUE(roundId,groupId,itemId));
CREATE TABLE media(id TEXT PRIMARY KEY,data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE notifications(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE opportunity_rules(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE promotion_ledger(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE promotional_targets(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE purchases(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE recovery_tokens(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT);
CREATE TABLE reminder_deliveries(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE reminders(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE reservations(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE roles(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT);
CREATE TABLE rounds(id TEXT PRIMARY KEY,data TEXT NOT NULL, campaignId TEXT, startedAt INTEGER, finishedAt INTEGER, status TEXT, dayKey TEXT, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE sale_events(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE sale_payments(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE sales(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE suppliers(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT,storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE templates(id TEXT PRIMARY KEY,data TEXT NOT NULL, storageMode TEXT NOT NULL DEFAULT 'whatsapp');
CREATE TABLE users(id TEXT PRIMARY KEY,data TEXT NOT NULL,createdAt INTEGER NOT NULL DEFAULT 0,campaignId TEXT,userId TEXT,status TEXT,kind TEXT);
CREATE INDEX alert_recipients_campaign ON alert_recipients(campaignId,createdAt DESC);
CREATE INDEX alert_recipients_created ON alert_recipients(createdAt DESC);
CREATE INDEX alert_recipients_mode ON alert_recipients(storageMode);
CREATE INDEX alert_recipients_status ON alert_recipients(status,createdAt DESC);
CREATE INDEX alert_recipients_user ON alert_recipients(userId,createdAt DESC);
CREATE INDEX alerts_campaign ON alerts(campaignId,createdAt DESC);
CREATE INDEX alerts_client_message ON alerts(json_extract(data,'$.clientMessageId'));
CREATE INDEX alerts_created ON alerts(createdAt DESC);
CREATE INDEX alerts_message_status ON alerts(json_extract(data,'$.messageId'),status);
CREATE INDEX alerts_mode ON alerts(storageMode);
CREATE INDEX alerts_pending_due ON alerts(status,COALESCE(json_extract(data,'$.nextAttemptAt'),0),json_extract(data,'$.channel'),createdAt);
CREATE INDEX alerts_status ON alerts(status,createdAt DESC);
CREATE INDEX alerts_user ON alerts(userId,createdAt DESC);
CREATE INDEX audit_campaign ON audit(campaignId,createdAt DESC);
CREATE INDEX audit_created ON audit(createdAt DESC);
CREATE INDEX audit_mode ON audit(storageMode);
CREATE INDEX audit_status ON audit(status,createdAt DESC);
CREATE INDEX audit_user ON audit(userId,createdAt DESC);
CREATE UNIQUE INDEX buscas_authorizations_principal ON buscas_authorizations(principalId) WHERE principalId IS NOT NULL;
CREATE UNIQUE INDEX buscas_authorizations_principal_simulation ON buscas_authorizations_simulation(principalId) WHERE principalId IS NOT NULL;
CREATE INDEX buscas_deliveries_message ON buscas_deliveries(messageId,status);
CREATE INDEX buscas_deliveries_message_simulation ON buscas_deliveries_simulation(messageId,status);
CREATE INDEX buscas_deliveries_run ON buscas_deliveries(runId,createdAt);
CREATE INDEX buscas_deliveries_run_simulation ON buscas_deliveries_simulation(runId,createdAt);
CREATE INDEX buscas_deliveries_status_due ON buscas_deliveries(status,nextAttemptAt,createdAt);
CREATE INDEX buscas_deliveries_status_due_simulation ON buscas_deliveries_simulation(status,nextAttemptAt,createdAt);
CREATE INDEX buscas_gaps_time ON buscas_gaps(startedAt DESC);
CREATE INDEX buscas_gaps_time_simulation ON buscas_gaps_simulation(startedAt DESC);
CREATE INDEX buscas_history_time ON buscas_history(createdAt DESC);
CREATE INDEX buscas_history_time_simulation ON buscas_history_simulation(createdAt DESC);
CREATE INDEX buscas_history_user_time ON buscas_history(userId,createdAt DESC);
CREATE INDEX buscas_history_user_time_simulation ON buscas_history_simulation(userId,createdAt DESC);
CREATE INDEX buscas_inbox_status_time ON buscas_inbox(status,createdAt);
CREATE INDEX buscas_inbox_status_time_simulation ON buscas_inbox_simulation(status,createdAt);
CREATE INDEX buscas_messages_chat_time ON buscas_messages(chatId,originalAt DESC);
CREATE INDEX buscas_messages_chat_time_simulation ON buscas_messages_simulation(chatId,originalAt DESC);
CREATE INDEX buscas_messages_time ON buscas_messages(originalAt DESC);
CREATE INDEX buscas_messages_time_simulation ON buscas_messages_simulation(originalAt DESC);
CREATE INDEX buscas_offers_filters ON buscas_offers(modelKey,storageGB,colorKey,condition,messageAt DESC);
CREATE INDEX buscas_offers_filters_simulation ON buscas_offers_simulation(modelKey,storageGB,colorKey,condition,messageAt DESC);
CREATE INDEX buscas_offers_fingerprint ON buscas_offers(fingerprint,messageAt DESC);
CREATE INDEX buscas_offers_fingerprint_simulation ON buscas_offers_simulation(fingerprint,messageAt DESC);
CREATE INDEX buscas_offers_message ON buscas_offers(chatId,messageId);
CREATE INDEX buscas_offers_message_simulation ON buscas_offers_simulation(chatId,messageId);
CREATE INDEX buscas_offers_product ON buscas_offers(supplierKey,productKey,messageAt DESC);
CREATE INDEX buscas_offers_product_simulation ON buscas_offers_simulation(supplierKey,productKey,messageAt DESC);
CREATE INDEX buscas_offers_rank ON buscas_offers(confidence,status,priceCents,messageAt DESC);
CREATE INDEX buscas_offers_rank_simulation ON buscas_offers_simulation(confidence,status,priceCents,messageAt DESC);
CREATE INDEX buscas_offers_time ON buscas_offers(messageAt DESC);
CREATE INDEX buscas_offers_time_simulation ON buscas_offers_simulation(messageAt DESC);
CREATE UNIQUE INDEX buscas_runs_command ON buscas_runs(chatId,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL;
CREATE UNIQUE INDEX buscas_runs_command_simulation ON buscas_runs_simulation(chatId,messageId) WHERE chatId IS NOT NULL AND messageId IS NOT NULL;
CREATE INDEX buscas_runs_status_time ON buscas_runs(status,createdAt DESC);
CREATE INDEX buscas_runs_status_time_simulation ON buscas_runs_simulation(status,createdAt DESC);
CREATE INDEX buscas_runs_user_time ON buscas_runs(userId,createdAt DESC);
CREATE INDEX buscas_runs_user_time_simulation ON buscas_runs_simulation(userId,createdAt DESC);
CREATE INDEX buyer_demands_mode ON buyer_demands(storageMode);
CREATE INDEX buyer_demands_mode_status_time ON buyer_demands(storageMode,status,createdAt DESC);
CREATE INDEX buyer_demands_mode_user ON buyer_demands(storageMode,userId,createdAt DESC);
CREATE INDEX campaigns_mode ON campaigns(storageMode);
CREATE INDEX campaigns_owner ON campaigns(json_extract(data,'$.ownerId'));
CREATE INDEX campaigns_state ON campaigns(json_extract(data,'$.state'));
CREATE INDEX cash_movements_mode ON cash_movements(storageMode);
CREATE INDEX cash_movements_mode_created ON cash_movements(storageMode,createdAt DESC);
CREATE INDEX cash_movements_mode_status_time ON cash_movements(storageMode,status,createdAt DESC);
CREATE INDEX cash_movements_mode_user ON cash_movements(storageMode,userId,createdAt DESC);
CREATE INDEX cash_movements_session ON cash_movements(storageMode,json_extract(data,'$.cashSessionId'),createdAt DESC);
CREATE INDEX cash_sessions_mode ON cash_sessions(storageMode);
CREATE INDEX cash_sessions_mode_status_time ON cash_sessions(storageMode,status,createdAt DESC);
CREATE INDEX cash_sessions_mode_user ON cash_sessions(storageMode,userId,createdAt DESC);
CREATE INDEX commerce_deliveries_due ON commerce_deliveries(storageMode,status,json_extract(data,'$.nextAttemptAt'));
CREATE INDEX commerce_deliveries_message ON commerce_deliveries(storageMode,json_extract(data,'$.messageId'));
CREATE INDEX commerce_deliveries_mode ON commerce_deliveries(storageMode);
CREATE INDEX commerce_deliveries_mode_status_time ON commerce_deliveries(storageMode,status,createdAt DESC);
CREATE INDEX commerce_deliveries_mode_user ON commerce_deliveries(storageMode,userId,createdAt DESC);
CREATE INDEX commerce_matches_mode ON commerce_matches(storageMode);
CREATE INDEX commerce_matches_mode_status_time ON commerce_matches(storageMode,status,createdAt DESC);
CREATE INDEX commerce_matches_mode_user ON commerce_matches(storageMode,userId,createdAt DESC);
CREATE INDEX commercial_lists_mode ON commercial_lists(storageMode);
CREATE INDEX commercial_lists_mode_status_time ON commercial_lists(storageMode,status,createdAt DESC);
CREATE INDEX commercial_lists_mode_user ON commercial_lists(storageMode,userId,createdAt DESC);
CREATE INDEX contact_categories_mode ON contact_categories(storageMode);
CREATE INDEX contact_categories_mode_status_time ON contact_categories(storageMode,status,createdAt DESC);
CREATE INDEX contact_categories_mode_user ON contact_categories(storageMode,userId,createdAt DESC);
CREATE INDEX contact_intake_events_mode ON contact_intake_events(storageMode);
CREATE INDEX contact_intake_events_mode_status_time ON contact_intake_events(storageMode,status,createdAt DESC);
CREATE INDEX contact_intake_events_mode_user ON contact_intake_events(storageMode,userId,createdAt DESC);
CREATE INDEX contact_pending_mode ON contact_pending(storageMode);
CREATE INDEX contact_pending_mode_status_time ON contact_pending(storageMode,status,createdAt DESC);
CREATE INDEX contact_pending_mode_user ON contact_pending(storageMode,userId,createdAt DESC);
CREATE INDEX contact_pending_phone ON contact_pending(storageMode,json_extract(data,'$.phone'),status);
CREATE INDEX contacts_campaign ON contacts(campaignId,createdAt DESC);
CREATE INDEX contacts_created ON contacts(createdAt DESC);
CREATE INDEX contacts_mode ON contacts(storageMode);
CREATE INDEX contacts_phone_mode ON contacts(storageMode,json_extract(data,'$.phone'));
CREATE INDEX contacts_status ON contacts(status,createdAt DESC);
CREATE INDEX contacts_user ON contacts(userId,createdAt DESC);
CREATE INDEX daily_reports_mode ON daily_reports(storageMode);
CREATE INDEX daily_reports_mode_status_time ON daily_reports(storageMode,status,createdAt DESC);
CREATE INDEX daily_reports_mode_user ON daily_reports(storageMode,userId,createdAt DESC);
CREATE INDEX diagnostics_campaign ON diagnostics(campaignId,createdAt DESC);
CREATE INDEX diagnostics_created ON diagnostics(createdAt DESC);
CREATE INDEX diagnostics_mode ON diagnostics(storageMode);
CREATE INDEX diagnostics_mode_trace ON diagnostics(storageMode,json_extract(data,'$.traceId'),createdAt DESC);
CREATE INDEX diagnostics_status ON diagnostics(status,createdAt DESC);
CREATE INDEX diagnostics_user ON diagnostics(userId,createdAt DESC);
CREATE INDEX group_progress_mode_campaign ON group_progress(storageMode,campaignId);
CREATE INDEX group_rounds_mode_campaign ON group_rounds(storageMode,campaignId);
CREATE INDEX groups_data_mode ON groups_data(storageMode);
CREATE INDEX history_campaign_time ON history(campaignId,createdAt DESC);
CREATE INDEX history_category_time ON history(category,createdAt DESC);
CREATE INDEX history_mode ON history(storageMode);
CREATE INDEX history_mode_category_time ON history(storageMode,category,createdAt DESC);
CREATE INDEX history_status_time ON history(status,createdAt DESC);
CREATE INDEX inventory_available ON inventory(storageMode,status,json_extract(data,'$.kind'));
CREATE INDEX inventory_mode ON inventory(storageMode);
CREATE INDEX inventory_mode_status_time ON inventory(storageMode,status,createdAt DESC);
CREATE INDEX inventory_mode_user ON inventory(storageMode,userId,createdAt DESC);
CREATE INDEX jobs_campaign_day ON jobs(campaignId,dayKey,attempts);
CREATE INDEX jobs_campaign_status ON jobs(campaignId,status);
CREATE INDEX jobs_client_message ON jobs(json_extract(data,'$.clientMessageId'));
CREATE INDEX jobs_created ON jobs(createdAt DESC);
CREATE INDEX jobs_group ON jobs(campaignId,groupId,roundId);
CREATE INDEX jobs_message ON jobs(messageId,status);
CREATE INDEX jobs_mode ON jobs(storageMode);
CREATE INDEX jobs_mode_status ON jobs(storageMode,status);
CREATE INDEX jobs_round_status ON jobs(roundId,status);
CREATE INDEX media_mode ON media(storageMode);
CREATE INDEX notifications_campaign ON notifications(campaignId,createdAt DESC);
CREATE INDEX notifications_created ON notifications(createdAt DESC);
CREATE INDEX notifications_mode ON notifications(storageMode);
CREATE INDEX notifications_status ON notifications(status,createdAt DESC);
CREATE INDEX notifications_user ON notifications(userId,createdAt DESC);
CREATE INDEX opportunity_rules_mode ON opportunity_rules(storageMode);
CREATE INDEX opportunity_rules_mode_status_time ON opportunity_rules(storageMode,status,createdAt DESC);
CREATE INDEX opportunity_rules_mode_user ON opportunity_rules(storageMode,userId,createdAt DESC);
CREATE INDEX promotion_ledger_mode ON promotion_ledger(storageMode);
CREATE INDEX promotion_ledger_mode_status_time ON promotion_ledger(storageMode,status,createdAt DESC);
CREATE INDEX promotion_ledger_mode_user ON promotion_ledger(storageMode,userId,createdAt DESC);
CREATE INDEX promotional_targets_mode ON promotional_targets(storageMode);
CREATE INDEX promotional_targets_mode_status_time ON promotional_targets(storageMode,status,createdAt DESC);
CREATE INDEX promotional_targets_mode_user ON promotional_targets(storageMode,userId,createdAt DESC);
CREATE INDEX purchases_mode ON purchases(storageMode);
CREATE INDEX purchases_mode_status_time ON purchases(storageMode,status,createdAt DESC);
CREATE INDEX purchases_mode_user ON purchases(storageMode,userId,createdAt DESC);
CREATE INDEX recovery_tokens_campaign ON recovery_tokens(campaignId,createdAt DESC);
CREATE INDEX recovery_tokens_created ON recovery_tokens(createdAt DESC);
CREATE INDEX recovery_tokens_status ON recovery_tokens(status,createdAt DESC);
CREATE INDEX recovery_tokens_user ON recovery_tokens(userId,createdAt DESC);
CREATE INDEX reminder_deliveries_due ON reminder_deliveries(storageMode,status,json_extract(data,'$.nextAttemptAt'));
CREATE INDEX reminder_deliveries_message ON reminder_deliveries(storageMode,json_extract(data,'$.messageId'));
CREATE INDEX reminder_deliveries_mode ON reminder_deliveries(storageMode);
CREATE INDEX reminder_deliveries_mode_status_time ON reminder_deliveries(storageMode,status,createdAt DESC);
CREATE INDEX reminder_deliveries_mode_user ON reminder_deliveries(storageMode,userId,createdAt DESC);
CREATE INDEX reminders_due ON reminders(storageMode,json_extract(data,'$.nextDueAt'));
CREATE INDEX reminders_mode ON reminders(storageMode);
CREATE INDEX reminders_mode_status_time ON reminders(storageMode,status,createdAt DESC);
CREATE INDEX reminders_mode_user ON reminders(storageMode,userId,createdAt DESC);
CREATE INDEX reservations_mode ON reservations(storageMode);
CREATE INDEX reservations_mode_status_time ON reservations(storageMode,status,createdAt DESC);
CREATE INDEX reservations_mode_user ON reservations(storageMode,userId,createdAt DESC);
CREATE INDEX roles_campaign ON roles(campaignId,createdAt DESC);
CREATE INDEX roles_created ON roles(createdAt DESC);
CREATE INDEX roles_status ON roles(status,createdAt DESC);
CREATE INDEX roles_user ON roles(userId,createdAt DESC);
CREATE INDEX rounds_campaign_day ON rounds(campaignId,dayKey);
CREATE INDEX rounds_campaign_start ON rounds(campaignId,startedAt);
CREATE INDEX rounds_mode ON rounds(storageMode);
CREATE INDEX sale_events_mode ON sale_events(storageMode);
CREATE INDEX sale_events_mode_status_time ON sale_events(storageMode,status,createdAt DESC);
CREATE INDEX sale_events_mode_user ON sale_events(storageMode,userId,createdAt DESC);
CREATE INDEX sale_events_sale ON sale_events(storageMode,json_extract(data,'$.saleId'),createdAt);
CREATE INDEX sale_payments_mode ON sale_payments(storageMode);
CREATE INDEX sale_payments_mode_status_time ON sale_payments(storageMode,status,createdAt DESC);
CREATE INDEX sale_payments_mode_user ON sale_payments(storageMode,userId,createdAt DESC);
CREATE INDEX sale_payments_received ON sale_payments(storageMode,json_extract(data,'$.receivedAt'));
CREATE INDEX sale_payments_reservation ON sale_payments(storageMode,json_extract(data,'$.reservationId'),createdAt DESC);
CREATE INDEX sale_payments_sale ON sale_payments(storageMode,json_extract(data,'$.saleId'),createdAt DESC);
CREATE INDEX sales_date ON sales(storageMode,json_extract(data,'$.soldAt'),status);
CREATE INDEX sales_mode ON sales(storageMode);
CREATE INDEX sales_mode_created ON sales(storageMode,createdAt DESC);
CREATE INDEX sales_mode_status_time ON sales(storageMode,status,createdAt DESC);
CREATE INDEX sales_mode_user ON sales(storageMode,userId,createdAt DESC);
CREATE INDEX suppliers_mode ON suppliers(storageMode);
CREATE INDEX suppliers_mode_status_time ON suppliers(storageMode,status,createdAt DESC);
CREATE INDEX suppliers_mode_user ON suppliers(storageMode,userId,createdAt DESC);
CREATE INDEX templates_mode ON templates(storageMode);
CREATE INDEX users_campaign ON users(campaignId,createdAt DESC);
CREATE INDEX users_created ON users(createdAt DESC);
CREATE INDEX users_status ON users(status,createdAt DESC);
CREATE INDEX users_user ON users(userId,createdAt DESC);
CREATE TRIGGER audit_immutable_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;
CREATE TRIGGER audit_immutable_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Auditoria imutável'); END;
CREATE TRIGGER sale_events_immutable_delete BEFORE DELETE ON sale_events BEGIN SELECT RAISE(ABORT,'Histórico financeiro imutável'); END;
CREATE TRIGGER sale_events_immutable_update BEFORE UPDATE ON sale_events BEGIN SELECT RAISE(ABORT,'Histórico financeiro imutável'); END;
PRAGMA user_version=8;
