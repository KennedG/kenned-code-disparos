# Validação — Automação Comunidade 1.0.1

Data: 15/10/2026. Projeto independente; nenhum banco ou sessão do Kenned Code Disparos foi usado para testar este aplicativo.

## Correção 1.0.1 — autorização de contatos

Causa reproduzida do erro genérico: o lote de autorização usava uma transação que lançava uma exceção ao encontrar um participante sem telefone confirmado, a própria conta ou um contato com restrição. Isso revertia também as autorizações dos contatos válidos. A seleção geral não diferenciava gestão de contatos e autorização de envio.

A correção mantém a transação para falhas de gravação, mas separa previamente a elegibilidade: os contatos aptos podem ser autorizados com consentimento explícito, e cada exclusão tem código e orientação. O backend reavalia a situação na gravação, inclusive se ela mudar depois da prévia. Edição somente de nome não tenta reautorizar nem muda a identidade ou a data do consentimento. Bloqueio, recusa e silêncio prevalecem sobre um checkbox antigo de autorização.

Falha secundária reproduzida: uma exceção na consulta local de vínculo PN/LID de um participante interrompia a importação dos demais. Essa consulta agora é isolada; o participante afetado continua sem telefone confirmado. Não se comprovou que essa falha secundária ocorreu na sessão do usuário. Os testes com o parser real do Baileys instalado não indicaram descarte de telefone legítimo no formato suportado.

Resultado da atualização: **171 testes automatizados aprovados**, incluindo 12 novos de autorização, quatro novos do adaptador e um de preservação do conjunto de dados da versão anterior. **Sete fluxos específicos de autorização e os dez fluxos gerais da interface foram aprovados no Electron com SQLite real**, sem conexão ao WhatsApp e sem envio de convites.

Não houve migração do esquema, limpeza de dados, troca do appId ou compartilhamento de sessão. A versão anterior e o backup de código foram preservados. Validação com a sessão e os participantes reais do computador do usuário continua pendente.

## O que foi implementado

- Sete áreas funcionais: Painel, Grupos e participantes, Campanhas, Contatos, Modelos, Histórico e Configurações.
- Sessão criptografada independente, QR Code, consulta de grupos/participantes, identificação segura e tratamento de PN/LID sem telefones inventados.
- Consentimento registrado, bloqueio, silêncio, recusa de mensagens e seleção individual ou em lote.
- Campanhas em rascunho; prévia personalizada e confirmação; novos somente ou reenvio explícito; programação, limites e intervalo por campanha em segundos/minutos.
- Fila sequencial persistente, reservas atômicas, controle global contra repetição, timeouts, resultados incertos, confirmação tardia e tentativas limitadas de falhas recuperáveis.
- Contagem regressiva, edição do intervalo em execução, pausa, retomada e parada geral. Reinício/reconexão/suspensão respeitam novamente o intervalo, sem rajadas de compensação.
- Modelos persistentes com criação, edição, duplicação, seleção e exclusão; histórico paginado, detalhes, cópia, exportação e limpeza visual que preserva o controle operacional.
- Backup SQLite validado, cópia anterior à restauração e preservação conservadora de envios/restrições posteriores ao backup.
- Instância única, worker de processamento, bandeja, inicialização com Windows e instalador independente.

## Falhas descobertas e corrigidas durante a implementação

| Causa reproduzida | Correção verificada |
| --- | --- |
| O bootstrap do Electron nem sempre define `require.main` como o módulo de entrada. | Inicialização identifica o processo principal do Electron; teste de regressão e abertura da interface real. |
| Filtros vazios de grupo/situação eram interpretados como filtros por identificador vazio. | Frontend e backend omitem filtros vazios; paginação é executada no SQLite. |
| Reconectar ou alterar o intervalo enquanto o destinatário era resolvido podia antecipar o envio. | A verificação final consulta novamente conexão, intervalo atual, autorização e estado persistido antes da submissão. |
| Suspensões curtas não eram necessariamente identificadas pela comparação dos relógios. | Eventos nativos de suspensão/retomada bloqueiam a fila e aplicam intervalo completo. |
| Uma interrupção após submissão podia ser confundida com cancelamento seguro anterior à submissão. | A classificação usa o estado persistido da submissão; permanece incerto e não volta automaticamente à fila. |
| Editar o nome personalizado após a prévia podia modificar o texto aprovado. | A impressão da prévia inclui o texto renderizado; alterações exigem nova aprovação. |
| O evento de recusa da integração não fornecia os campos de confiança esperados pelo backend. | Contrato corrigido e caminho real de extração do adaptador exercitado com evento controlado. |
| Um backup antigo podia apagar provas recentes de envio ou restaurar consentimento já revogado. | Restauração preserva provas operacionais, bloqueios, recusas e revogações posteriores, nos dois modos. |
| Um envio podia começar enquanto o diálogo de restauração estava aberto. | Nova verificação após escolher o arquivo; banco não é substituído com envio em andamento. |
| Cancelamentos feitos antes de restaurar removiam a reserva dos pendentes recuperados. | Sobreposição preserva somente provas duráveis e mantém reservas dos pendentes restaurados. |
| O histórico tinha dados operacionais disponíveis que não chegavam à tela de detalhes. | Cada página é enriquecida com a tarefa correspondente, incluindo texto, identificadores e horários. |
| O primeiro empacotamento a partir de dependências vinculadas omitiria bibliotecas transitivas do WhatsApp. | Esse pacote foi descartado. A compilação utiliza instalação própria das dependências a partir do lockfile; o carregamento da integração é verificado também no pacote. |

## Categorias de teste

Na versão inicial, foram aprovados 154 testes automatizados e dez fluxos na interface. Na atualização 1.0.1, a suíte completa passou a **171 testes, sem falhas ou testes ignorados**. Os arquivos de teste acompanham o código-fonte. A suíte usa **SQLite real** e, para transporte, **adaptadores controlados ou simulação explícita**. Foram exercitados:

- Mesmo participante em vários grupos, aliases confiáveis, identidade ambígua e número indisponível.
- Contato identificado sem autorização, autorização explícita, bloqueio, silêncio e recusa.
- Segunda execução, outra campanha/texto e limpeza visual sem repetir convites anteriores; novo contato continua elegível.
- Reenvio explícito, confirmação de risco de incerto, confirmação tardia que cancela uma repetição pendente.
- Ativações concorrentes, chave de execução idempotente, cliques repetidos e reserva única em SQLite, inclusive em workers distintos.
- Intervalos, aumento e redução durante execução, limites, programação, pausa, parada, reconexão, reinício e suspensão.
- Timeout com resultado incerto sem bloquear outros contatos; erros temporários com tentativas limitadas; aceitação e entrega em etapas distintas.
- Persistência de campanhas/modelos/intervalos, backup inválido, backup antigo, restauração concorrente e falha real de gravação por disco cheio.
- Inicialização, IPC com lista de ações permitidas, isolamento da interface, worker e recusa de armazenamento inseguro de sessão.

O teste de interface abre **Electron real**, utiliza preload/IPC/worker/banco/fila reais e interage com a interface. Os envios nesse teste continuam sendo simulados. O mesmo roteiro pode ser executado contra o `app.asar` gerado, por meio de `COMMUNITY_APP_PATH`.

## O que não está comprovado por esses testes

- **Envio aceito por uma sessão WhatsApp real:** pendente, pois não há sessão conectada/autenticada deste aplicativo no ambiente de entrega.
- **Entrega confirmada ou recebimento em celular:** pendente. Nenhum envio foi feito a clientes, participantes reais ou grupos de produção.
- **Instalação e execução em Windows 10/11 físico, DPAPI, bandeja e inicialização no Windows:** exigem validação no computador Windows de teste. Verificação de formato/extração do instalador e execução do ASAR em Electron não substituem isso.
- **Certificado de assinatura de código:** não foi fornecido. O instalador não tem assinatura Authenticode; o Windows pode solicitar confirmação ao abri-lo.

## Roteiro final com WhatsApp autorizado

1. Instale no computador Windows de teste e conecte uma conta pelo QR Code. Use somente grupo e destinatário de teste autorizados.
2. Sincronize o grupo, atualize participantes e confirme número/identidade. Registre a autorização do destinatário de teste.
3. Prepare um convite identificável, confira a prévia e inicie com intervalo de 30 segundos e limite de uma mensagem. Registre o ID da operação e confira o recebimento no celular; aceitação não equivale a recebimento.
4. Execute outra vez em “Somente novos”: o destinatário anterior deve ser excluído. Adicione um novo contato autorizado para validar inclusão apenas do novo.
5. Valide reenvio explícito, pausa, desconexão/reconexão e reinício. Nunca aprove repetição de incerto sem revisar a evidência e o risco.
6. Confirme que backup/restauração e atualização mantêm os cadastros e o bloqueio dos já convidados. Mantenha a cópia anterior à restauração para recuperação.

Não utilize números reais na simulação. O simulador só aceita seu conjunto interno de identidades fictícias e não possui transporte para o WhatsApp.
