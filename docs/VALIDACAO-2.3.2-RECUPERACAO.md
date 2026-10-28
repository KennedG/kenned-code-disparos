# Validação da revisão 2.3.2 — recuperacao-r2

Este documento é um roteiro e define as evidências necessárias. Os números finais e resultados executados constam do arquivo **Kenned-Code-Disparos-2.3.2-Recuperacao-Validacao.json** e dos logs entregues; uma linha deste roteiro não representa, por si só, um teste aprovado.

## Classes de evidência

| Classe | O que comprova | O que não comprova |
| --- | --- | --- |
| Teste automatizado | Regras executadas, estado persistente e resultado esperado | WhatsApp real, som ou notificação no Windows físico |
| Integração controlada | Eventos/socket controlados percorrendo os serviços reais | Aceitação pelo servidor WhatsApp ou recebimento no celular |
| Interface e conteúdo empacotado | Interface Electron e runtime extraído do instalador | Instalação NSIS no Windows, DPAPI ou política de foco física |
| Envio aceito pela integração real | Identificador e confirmação disponível da submissão | Entrega ou leitura |
| Entrega confirmada | Recibo efetivamente recebido | Leitura ou confirmação humana |
| Recebimento no celular de teste | Confirmação pelo dono no destinatário autorizado | Garantia de entrega de todos os envios futuros |

## Agendamento, recuperação e persistência

- Abrir antes da janela e conferir que não há submissão.
- Grade iniciada às 08:00 com dez minutos: 08:00, 08:10, 08:20; atraso não muda o alinhamento.
- Rodada mais demorada que o intervalo: sem sobreposição ou compensação de todas as rodadas perdidas.
- Desconectar às 14:03, recuperar às 14:07: alerta pode sair; campanha somente às 14:10.
- Recuperar depois do término: nenhum envio fora da janela; próximo dia permitido, se autorizado pela programação.
- Campanha nunca iniciada no dia, pausada, parada manualmente, sem autorização preservada ou alterada após erro: sem ativação indevida.
- Desconexão manual: nenhuma tentativa automática.
- Sessão aberta, mas ainda sem prontidão: sem envio ou indicação prematura de recuperação.
- Queda no meio da rodada: preservar identificadores, enviar somente pendências no próximo horário, manter incertezas sem repetição cega.
- Reiniciar, suspender/retomar e mudar horário/fuso: recalcular a grade e persistir os bloqueios.
- Falha confirmada recuperável: tentativas limitadas; falha de grupo não bloqueia destinos aptos; falha global pausa todos.
- Confirmação tardia e republicação: não duplicar tarefa, rodada ou mensagem.
- Falha de gravação: impedir nova submissão sem registro durável.
- Licença vencida ou parada geral: recuperação não burla os bloqueios.

## Incidentes e alarmes

- Registrar incidente antes de tentar alertar; conservar horário, campanha, pendências, motivo e rastreamento.
- Sem conexão: aviso visual e som conforme preferências; privado pendente.
- Recuperar: cessar alarme do incidente resolvido e liberar o alerta pendente com os dois horários, sem iniciar imediatamente a campanha.
- Evento duplicado: um incidente, sem vários sons ou repetidas solicitações de foco.
- Silenciar: som para; aviso permanece. Novo incidente pode tocar novamente.
- Repetição persistente, volume zero, mudo do Windows, áudio próprio e horário silencioso.
- Janela minimizada: restauração/solicitação de foco; fallback por barra de tarefas e notificação quando o Windows impedir foco.
- Falha do alerta: status fiel, tentativas limitadas, sem alerta recursivo.

## Origem e BUSCAS

- Seleção por ID real, nome do grupo alterado e reconexão sem multiplicar assinaturas.
- Texto novo, foto com legenda e publicação manual pela conta conectada; mídia salva antes de item pronto.
- Publicação de participante não autorizado ignorada; mensagem automática/legenda não vira comando.
- Evento live do tipo `append`, evento `notify`, repetição, histórico não solicitado e recuperação de mensagem cifrada: classificar sem perder publicação nova nem reimportar todo o passado.
- Download com falha sem bloquear outros itens; duplicação de eventos sem duplicação de publicações/ofertas.
- Sincronizar: lista e monitor atualizados, sem alegar histórico completo ou iniciar campanhas.
- Testar captura: aguardar evidência nova; confirmar somente após persistência e estado pronto, ou exibir expiração/falha.
- Campanha excluída: manter a pausa, sem recriação automática ou repetição de “Campanha não encontrada”.
- Listas com vários aparelhos e preços: separar ofertas e preservar referências, sem tratar parcelas ou entradas como preço total.
- Filtros e limite de duas horas pela data original, resultados ausentes e captura desatualizada explicitados.
- Comando do particular autorizado para a loja: autorizar pelo remetente confiável e responder no mesmo privado.
- Não autorizado, permissão insuficiente ou local bloqueado: sem execução.
- Excel e envio aos responsáveis: números resolvidos sem substituição silenciosa; fila, aceitação, entrega, falha e incerteza distintos.
- Modo real sem fixtures; troca de modo sem contaminar grupos, filtros ou resultados.

## Regressão, pacote e preservação

- Manter Oportunidades e limites contra repetição, modelos com mídias, lembretes, contatos, exclusão protegida de mídia, exportação Excel e menu recolhível.
- Preservar licenciamento byte a byte nos arquivos existentes; não expor as 120 chaves comerciais, dez chaves de teste, token administrativo ou componente privado da assinatura.
- Preservar o ID do aplicativo e o perfil legado, conferir backup recuperável antes da preparação do banco e testar rollback com perfil compatível.
- Conferir CRC do instalador e payload, arquitetura AMD64, hashes dos fontes congelados dentro do ASAR e fonte ZIP completo.
- Testar a interface usando o ASAR retirado do instalador e conferir nova identidade KC sem distorção.
- Instalar Windows 10/11 em equipamento autorizado, abrir novamente e conferir banco/licença; esse teste exige Windows físico.

## Teste real que exige participação do dono

O destinatário particular foi informado de forma privada; não deve aparecer em repositório público, logs exportados ou artefatos de distribuição. É preciso conectar uma sessão da loja e selecionar um grupo de teste autorizado. Não usar clientes ou grupos de produção.

1. Confira licença, responsável e permissões; prepare rastreamento e deixe campanhas reais pausadas.
2. Na origem, clique **Testar captura** e publique uma foto com legenda preservando emojis, preço, observação e assinatura. Confira o identificador e a mídia pronta na campanha.
3. Em BUSCAS, arme o teste e publique uma lista no grupo monitorado de teste. Confira mensagem persistida e quantidade de ofertas.
4. Do particular informado, envie `!busca iPhone 15 Pro Max 256GB`, `!busca`, pesquisa sem resultado, `!busca --excel iPhone 15 Pro Max 256GB` e os comandos administrativos. Confira retorno exclusivo ao mesmo particular e abra o Excel recebido.
5. Use **Enviar alerta de teste**. Provoque uma queda controlada e confirme o privado pendente; reconecte entre duas rodadas e confira alerta recebido sem disparo antecipado da campanha.
6. Execute `!mega parar tudo` somente no ambiente controlado. Confirme o bloqueio de novas automações e a retomada explícita.
7. Confirme no celular cada recebimento e guarde identificadores/horários da integração, distinguindo aceitação, entrega e confirmação humana.

Sem essa sessão, a classe **WhatsApp real** permanece **não validada**. Sem Windows físico, som, foco, notificações, DPAPI e versão instalada permanecem **não validados**. Testes automatizados não alteram essas pendências.
