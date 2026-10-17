import { ProviderError } from '../ai/provider-error.js';

export function assertExternalOperationsEnabled(database) {
  const settings = database.prepare('SELECT external_operations_enabled FROM automation_settings WHERE id = 1').get();
  if (settings?.external_operations_enabled !== 1) {
    throw new ProviderError(
      'external_operations_disabled',
      'Las operaciones externas están desactivadas globalmente. Habilítalas en Automatizaciones antes de continuar.',
      { status: 423 },
    );
  }
}
