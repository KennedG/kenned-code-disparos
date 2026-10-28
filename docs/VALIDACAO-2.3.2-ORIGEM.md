# Validação 2.3.2 — Origem da loja, revisão origem-r1

Este documento registra escopo, evidências e pendências da revisão **origem-r1**, mantendo a versão 2.3.2. O manifesto final da entrega informa contagem consolidada dos testes, hashes dos artefatos e verificações do pacote. A existência de uma suíte ou a aprovação de um teste automatizado não comprova recepção por uma conta real de WhatsApp.

## Causas técnicas e correções

| Problema observado no código | Correção e limite da evidência |
|---|---|
| Promessa de transporte sem resolução podia permanecer aguardada pela fila compartilhada; um limite de ACK que só começa depois dessa resolução não libera a fila durante o travamento. | Prazo externo por tentativa com sinal de encerramento e guarda final. Resultado ambíguo permanece incerto; a fila segue para tarefas elegíveis. Testes usam promessas realmente pendentes e o Scheduler de produção. |
| Resultado incerto interrompia o processamento da campanha/demais destinos. | O registro incerto continua protegido contra repetição, mas outros itens/destinos podem seguir. Só perda geral de conexão suspende a execução global; indisponibilidade de um grupo é tratada por destino. |
| Preparação de mídia ou resposta tardia podia concluir depois do prazo e da mudança de estado. | Guardas no último limite de submissão, sinal de cancelamento e conciliação por operação/identificador. Recibo tardio atualiza a evidência do mesmo envio; não gera tarefa nova. |
| Não havia montagem diária integrada a partir de foto com legenda no grupo de origem. | Captura separada por eventos, autorização de participantes, ledger único por modo/grupo/mensagem e campanha única por modo/grupo/data em Brasília. Mídia salva antecede item pronto. |
| Falhas de grupo sem classificação específica podiam ser tratadas como falha global ou repetidas sem finalidade. | Consulta de metadados quando suportada, classificação no envio, suspensão individual e rechecagem. Metadados incompletos ou ambíguos não viram motivo confirmado. |
| Alertas de um grupo recorrente podiam gerar mensagens repetidas ou ocupar a fila quando a própria tentativa não respondia. | Primeira ocorrência e resumo agrupado persistente, prazos por consulta/envio, tentativas seguras limitadas com atraso progressivo e ausência de recursão por erro do alerta. |
| Validação do esquema 8 podia recusar SQL equivalente somente por sua representação escrita. | Comparação estrutural/cosmética compatível com a migração histórica, mantendo colunas/índices/restrições necessários, cópia anterior verificada e header 8 preservado. Foi reproduzido em bancos de teste; o banco particular do Drive não foi inspecionado. |

O serviço de licenciamento e sua chave pública de confiança permanecem os da 2.3.2. Esta revisão não cria nem consome chaves comerciais. Alterações visuais não são utilizadas como evidência de envio, persistência ou autorização.

## Testes automatizados e controlados

| Suíte | Fluxos cobertos |
|---|---|
| `test/source-campaigns-232.test.cjs` | Foto/legenda/bytes/Unicode, mensagens próprias verificadas, autor não autorizado, data original e virada de Brasília, campanha única, download com erro/prazo, revisão de texto separado, reinício, proteção do contexto, edições/exclusões, tombstones, ordenação/agrupamento e isolamento dos modos. |
| `test/adapter-source-232.test.cjs` | Eventos Baileys com socket controlado, PN/LID, foto/legenda, álbum explícito, protocolo de edição/revogação, identidade própria, metadados de grupo, restrição a administradores, participação, erro 403, ACK tardio, upload/download abortado e diferenças de mídia. |
| `test/queue-resilience-232.test.cjs` | Envio pendente com prazo, continuidade da fila, falha individual versus geral, recibo positivo/negativo tardio, snapshots de rodada, novo item na próxima, exclusão antes de submeter, intervalos distintos, rodadas/encerramento, pausa, conciliação e repetição manual protegida contra duplo clique. |
| `test/alerts-destination-232.test.cjs` | Primeiro aviso com grupo/ID/motivo, recorrências e resumo, outro destino independente, offline/reconexão, SQLite após reinício, destinatário revogado, proteção de segredos, ausência de cascata, atraso progressivo, timeout e conciliação tardia. Inclui o Scheduler de produção e SQLite real na coordenação da fila privada. |
| `test/alerts.test.cjs` e `test/alerts-231.test.cjs` | Regressão dos alertas, teste pelo fluxo de produção, aceitação/entrega separadas, resolução do particular/conta própria, permissões, parada geral, falha conhecida/incerta e desconexão. |
| `test/backend-source-232.test.cjs` | Login/permissões/escopo, ações autorizadas, modelo/configuração persistentes, métricas por campanha, isolamento real/simulado, licença, parada geral, reconciliação e reativação de grupo sem início automático. |
| `test/private-delivery-deadline-232.test.cjs` | Resposta de busca e lembrete não bloqueiam a fila após prazo; guarda final impede envio obsoleto, autorizações continuam ativas e aceitação não vira entrega. |
| `test/source-ui-232.test.cjs` e teste Electron da entrega | Fluxos da interface de origem/campanha/monitoramento, ações ligadas às APIs e apresentação de resultados. O manifesto identifica separadamente execução em desenvolvimento e com o pacote final. |
| Suítes de esquema, licenças e recursos anteriores | Compatibilidade SQL histórica e snapshots, preservação do esquema 8 conhecido, rejeição de estrutura verdadeiramente incompatível, guardas de campanhas de outra linha, licença, BUSCAS/Excel, modelos/mídias, lembretes, contatos, permissões e parada geral. |

As 15 verificações novas de alertas, somadas às 50 de regressão desses alertas, passaram na execução específica do módulo. A contagem e o resultado completos da revisão, incluindo mudanças feitas posteriormente por outros módulos, pertencem ao manifesto final da entrega. Não derive um resultado global apenas dessa contagem parcial.

SQLite e arquivos temporários são usados nos testes de persistência; o adaptador de rede é simulado ou um socket autenticado controlado. Testes de licença exercitam o código preservado e comprovantes/servidor conforme identificado no relatório correspondente; isso não transforma transporte WhatsApp controlado em WhatsApp real.

## O que cada evidência significa

| Evidência | O que permite afirmar |
|---|---|
| Teste automatizado | A asserção do código passou no cenário especificado. |
| Integração simulada | O adaptador fictício apresentou o resultado programado; nenhum telefone real recebeu. |
| Socket controlado | Eventos e respostas do protocolo foram injetados no adaptador de produção; não comprova envio à rede real. |
| Envio aceito pela integração real | Houve confirmação real de aceitação daquela operação, com identificador. Não comprova recebimento no celular. |
| Entrega confirmada | Houve recibo real de entrega correspondente, quando suportado. Não comprova leitura humana. |
| Recebimento confirmado no celular de teste | O participante autorizado conferiu a mensagem/mídia no aparelho correto. |
| Pacote Windows executado em ambiente compatível de desenvolvimento | Verifica recursos contidos no pacote e lógica/interface executadas; não comprova instalação, DPAPI, notificações ou áudio em Windows físico. |

Um job que entrou na fila continua aguardando. Ausência de ACK continua incerta. Uma revisão manual possui escopo explícito de revisão e não é apresentada como recibo do WhatsApp. Os registros `confirmed` legados de aceitação são identificados como aceitos, separadamente de `delivered`.

## Pendências externas desta revisão

- **WhatsApp real:** não havia sessão da loja conectada nem conta/grupos/número particular de teste acessíveis. Não foi estabelecido envio aceito real, recibo real ou recebimento físico de alerta, campanha, comando privado, lista ou Excel nesta revisão.
- **Windows físico:** instalação/atualização pelo EXE, bandeja, atalhos, DPAPI, QR, notificações nativas e volume audível precisam ser verificados no Windows 10/11 de teste. As verificações do arquivo empacotado são registradas separadamente.
- **Banco particular:** o arquivo informado no Drive tem aproximadamente 620 MB e excedeu o limite do conector utilizado. Bancos gerados por migração histórica e fixtures equivalentes foram usados para regressão; não se afirma compatibilidade confirmada com aquele arquivo não lido.
- **Histórico e álbuns:** disponibilidade depende da integração. A importação retorna somente mensagens realmente fornecidas e não declara histórico completo; vínculo de álbum só é aceito quando explícito ou criado manualmente.
- **Edições, exclusões e grupos:** só eventos recebidos e metadados confiáveis sustentam atualização, remoção ou diagnóstico confirmado. Uma permissão pode mudar após a pré-verificação e é reavaliada no momento do envio.

Nenhuma dessas pendências é satisfeita por preencher a tela com demonstração, remover autorização, trocar destinatários por suposição ou declarar sucesso na inclusão da fila.

## Roteiro de aceitação em conta de teste autorizada

1. Abra a revisão no Windows de teste, confirme a licença existente e a cópia de recuperação. Use somente o particular e grupos designados para testes; não utilize clientes nem interrompa campanhas de produção.
2. Conecte a conta da loja, sincronize os grupos e escolha uma origem de teste. Cadastre o participante autorizado e habilite mensagens próprias manuais. Publique uma foto com legenda contendo modelo, preço, emojis, observação e assinatura. Confira bytes disponíveis da mídia, texto inteiro e horário original no rascunho.
3. Publique novamente uma mensagem diferente no mesmo dia: deve integrar a mesma campanha. Reenvio do mesmo evento não deve duplicá-la. Confira outra data em Brasília em cenário controlado. Mensagem de participante não autorizado e mensagens automáticas do aplicativo não devem entrar.
4. Configure dois destinos de teste, intervalos, quantidade de rodadas/encerramento e responsáveis autorizados. Confirme a prévia e o início. Publique/edite um item durante a execução e confira que a rodada atual mantém seu snapshot e a próxima usa o conteúdo atualizado.
5. Teste exclusão ou remoção manual antes de um envio iniciar; confira que o histórico já enviado permanece. Teste download com falha sem bloquear outra foto. Reinicie/reconecte e confirme ausência de duplicação da origem e de envios aceitos.
6. Em um destino de teste, configure envio só por administradores sem dar essa permissão à conta; mantenha outro destino acessível. Confira motivo confirmado, suspensão individual, continuidade do grupo apto e alerta no particular correto. Verifique novamente e reative o destino após corrigir a permissão.
7. Simule interrupção de conexão em ambiente controlado: a aplicação deve pausar, mostrar aviso local e preservar o alerta pendente. Reconecte; confira o horário original no resumo privado e diferencie aceitação, entrega e recebimento observado no particular.
8. Do particular autorizado, envie `!busca iPhone 15 Pro Max 256GB`, `!busca`, `!mega ajuda`, `!mega menu` e `!mega status`. A busca deve responder somente ao solicitante. Execute `!mega parar tudo` apenas neste ambiente controlado; confira filas interrompidas, novas automações bloqueadas e comandos administrativos preservados. Retome explicitamente quando desejar.
9. Use **Enviar alerta de teste** e registre o identificador da operação, destino, horário, aceitação/recibo quando disponíveis e confirmação de recebimento no celular. Não marque uma tentativa sem ACK como falha ou sucesso; reconcilie pelo ID e só repita manualmente após revisar o risco de duplicação.
10. Reabra o aplicativo, confirme licença e responsáveis preservados e valide o comportamento do instalador empacotado. Registre cada pendência não observável como pendência; a conclusão do teste exige evidência correspondente, não apenas clique em botão ou teste simulado.

Registre evidências sem senhas, tokens, sessão, metadados protegidos de mídia ou chaves de licença. Diagnóstico possui rastreamento por operação e etapa; código/motivo específico deve explicar a última etapa que falhou.
