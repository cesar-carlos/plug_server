// Run from an isolated checkout of plug_agente v1.8.6 with the local hub fixture.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:path/path.dart' as p;
import 'package:plug_agente/application/actions/agent_action_runtime_state_guard.dart';
import 'package:plug_agente/application/actions/agent_actions_remote_capability_provider.dart';
import 'package:plug_agente/application/actions/elevated_action_runner_readiness_service.dart';
import 'package:plug_agente/application/rpc/client_token_get_policy_rate_limiter.dart';
import 'package:plug_agente/application/rpc/rpc_method_dispatcher.dart';
import 'package:plug_agente/application/services/health_service.dart';
import 'package:plug_agente/application/services/protocol_negotiator.dart';
import 'package:plug_agente/application/services/query_normalizer_service.dart';
import 'package:plug_agente/application/use_cases/authorize_sql_operation.dart';
import 'package:plug_agente/application/use_cases/get_client_token_policy.dart';
import 'package:plug_agente/core/config/feature_flags.dart';
import 'package:plug_agente/core/settings/app_settings_store.dart';
import 'package:plug_agente/domain/repositories/i_config_connection_string_source.dart';
import 'package:plug_agente/domain/repositories/i_database_gateway.dart';
import 'package:plug_agente/infrastructure/datasources/socket_data_source.dart';
import 'package:plug_agente/infrastructure/external_services/socket_io_transport_client_v2.dart';
import 'package:plug_agente/infrastructure/metrics/metrics_collector.dart';
import 'package:uuid/uuid.dart';

class _Database extends Mock implements IDatabaseGateway {}

class _UnusedConnection extends Mock implements IConfigConnectionStringSource {}

class _Normalizer extends Mock implements QueryNormalizerService {}

class _Authorize extends Mock implements AuthorizeSqlOperation {}

class _Policy extends Mock implements GetClientTokenPolicy {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('historical ready agent refuses unimplemented extensions at the hub', () async {
    expect(File('pubspec.yaml').readAsStringSync(), matches(RegExp(r'^version: 1\.8\.6\+1\s*$', multiLine: true)));
    final oldOverrides = HttpOverrides.current;
    HttpOverrides.global = null;
    addTearDown(() => HttpOverrides.global = oldOverrides);
    final manifest = File(Platform.environment['ACTION_IO_HUB_MANIFEST']!);
    final root = manifest.parent.resolveSymbolicLinksSync();
    expect(p.dirname(root), Directory.systemTemp.resolveSymbolicLinksSync());
    expect(p.basename(root), matches(RegExp(r'^plug-action-io-[a-f0-9-]{36}$')));
    expect(manifest.resolveSymbolicLinksSync(), p.join(root, 'hub-ready.json'));
    expect(manifest.lengthSync(), lessThanOrEqualTo(16384));
    final info = jsonDecode(await manifest.readAsString()) as Map<String, dynamic>;
    expect(info['root'], root);
    expect(info['format'], 'action-io-hub-fixture-v1');
    expect(info['productionEnabled'], false);
    final uri = Uri.parse(info['hubUrl'] as String);
    expect(uri.scheme, 'http');
    expect(uri.host, '127.0.0.1');
    final flags = FeatureFlags(
      InMemoryAppSettingsStore({
        'feature_enable_agent_actions': true,
        'feature_enable_remote_agent_actions': true,
      }),
    );
    final database = _Database();
    final transport = SocketIOTransportClientV2(
      dataSource: SocketDataSource(),
      negotiator: ProtocolNegotiator(),
      featureFlags: flags,
      rpcDispatcher: RpcMethodDispatcher(
        databaseGateway: database,
        connectionStringSource: _UnusedConnection(),
        uuid: const Uuid(),
        healthService: HealthService(metricsCollector: MetricsCollector(), gateway: database),
        normalizerService: _Normalizer(),
        authorizeSqlOperation: _Authorize(),
        getClientTokenPolicy: _Policy(),
        getPolicyRateLimiter: ClientTokenGetPolicyRateLimiter(maxCallsPerMinute: 60),
        featureFlags: flags,
      ),
      options: SocketIOTransportClientV2Options(
        agentActionsRemoteCapabilityProvider: AgentActionsRemoteCapabilityProvider(
          runtimeStateGuard: AgentActionRuntimeStateGuard(),
          elevatedRunnerReadiness: ElevatedActionRunnerReadinessService(),
        ),
      ),
    );
    final ready = Completer<void>();
    transport.setMessageCallback((direction, event, data) {
      if (event == 'agent:ready' && !ready.isCompleted) ready.complete();
    });
    try {
      (await transport.connect(
        uri.toString(),
        info['agentId'] as String,
        authToken: info['agentAuthToken'] as String,
      )).getOrThrow();
      await ready.future.timeout(const Duration(seconds: 20));
      final next = File(p.join(root, 'reference-request.next'));
      final request = File(p.join(root, 'reference-request.json'));
      final result = File(p.join(root, 'reference-result.json'));
      expect([next, request, result].any((f) => f.existsSync()), false);
      await next.writeAsString(
        jsonEncode({'format': 'action-io-reference-v1', 'actionId': 'legacy-case', 'credential': 'fixture'}),
        flush: true,
      );
      await next.rename(request.path);
      final deadline = DateTime.now().add(const Duration(seconds: 60));
      while (!result.existsSync()) {
        if (DateTime.now().isAfter(deadline)) throw StateError('Timed out waiting for the client matrix');
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      final report = jsonDecode(await result.readAsString()) as Map<String, dynamic>;
      expect(report['success'], true);
      expect(report['transports'], ['rest', 'socket', 'relay']);
    } finally {
      await transport.disconnect();
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
