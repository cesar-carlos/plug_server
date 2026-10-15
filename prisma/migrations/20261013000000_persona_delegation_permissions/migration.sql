-- Existing identity delegations remain source-only; renewal is required to expand them.
ALTER TABLE client_persona_delegations ADD COLUMN administrative jsonb NOT NULL DEFAULT '["gerenciar_fontes"]'::jsonb;
ALTER TABLE client_persona_delegations ADD CONSTRAINT client_delegation_administrative
  CHECK (jsonb_typeof(administrative)='array' AND jsonb_array_length(administrative) BETWEEN 1 AND 5
    AND administrative <@ '["treinar","publicar","gerenciar_fontes","gerenciar_tokens","gerenciar_integracoes"]'::jsonb);
