# Alterações da versão 2.0.0

## Execução, desempenho e recuperação

- Banco, autenticação, campanhas e processamento de arquivos passaram para um worker dedicado. O processo principal mantém os recursos do Windows e a interface permanece isolada.
- SQLite nativo substitui a regravação completa do banco. WAL, transações duráveis, índices e consultas de contagem/progresso reduzem trabalho por envio. Histórico e diagnóstico são paginados; exportações escrevem páginas e mídias são copiadas/decodificadas em blocos.
- O controle operacional mantém identificadores, status e progresso antes de efeitos de rede. Reinício preserva confirmações e marca tentativas interrompidas como incertas. Nada incerto é reenviado automaticamente.
- Tentativas temporárias comprovadamente anteriores à submissão têm quantidade e intervalo configuráveis. Falhas definitivas encerram a campanha, e resultados ambíguos pausam para revisão. Fila, conexões, reconexões e eventos têm controles de concorrência e limites.
- Campos ainda não salvos e campos de configurações em edição são preservados durante atualizações periódicas da interface.

## Acesso e limpeza de históricos

- Cadastro do primeiro dono, login local, troca de senha temporária e recuperação com códigos de uso único. Senhas usam scrypt com sal individual.
- Perfis Dono, Administrador, Responsável e Vendedor, perfis personalizados, matriz de permissões e visibilidade de campanhas próprias/todas. Verificações no backend também valem para comandos WhatsApp.
- Último dono protegido, acesso desativável, vínculo de telefone e auditoria de ações importantes.
- Limpeza por categoria com prévia, exportação e confirmação digitada **APAGAR**. Auditoria separada registra autor/horário. Dados cadastrados e ledger operacional permanecem; limpar históricos não cria autorização para repetir mensagens.

## Alertas e diagnóstico

- Alertas privados de falhas para donos com telefone, responsáveis e destinatários selecionados. Uma ocorrência por destino, estado pendente/confirmado/incerto/falha e recuperação sem duplicar.
- Aviso local imediato em desconexão e falha crítica; privados ficam pendentes enquanto a conexão não permite envio. Mensagens mantêm o horário original da ocorrência.
- Reconexão automática com limite e intervalo; retomada automática opcional, sem retomar pausa manual ou campanhas com resultado incerto.
- Notificações nativas solicitadas ao Windows, com resultado aceito/falha registrado pelos eventos da API.
- Som configurável, volume 0–100%, áudio próprio, teste, eventos, repetição limitada, horário silencioso e silenciamento por ocorrência.
- Canal independente opcional por endpoint HTTPS. Confirmação de aceitação no endpoint é distinta de entrega WhatsApp.
- Diagnóstico filtrado/paginado com código, etapa, tentativas, ação, orientação, cópia e exportação. Retenção por dias, quantidade e tamanho preserva o controle operacional.

## Compatibilidade e limitações

O instalador e o diretório `%APPDATA%\Mega Disparos` mantêm sua identidade. A migração cria cópia anterior do SQLite; o primeiro dono adota campanhas legadas sem proprietário. Backup/restauração continua compatível com `.mega.json`, sem incluir usuários, hashes de senha, recuperação, sessões ou credenciais. Campanhas restauradas começam desativadas em simulação.

A conexão continua usando **Baileys não oficial**, com as limitações descritas em [INTEGRACAO.md](INTEGRACAO.md). Não houve conexão ou envio WhatsApp real nem máquina Windows física nesta execução. A validação automatizada e a interface Electron foram exercitadas em Linux com dados simulados; instalação, notificações e áudio físico do Windows e transporte real ainda precisam ser verificados. O relatório com evidências está em [VALIDACAO.md](VALIDACAO.md).
