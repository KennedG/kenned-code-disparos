# Kenned Code Disparos 2.3.2 — Envio imediato R4

Base: revisão Oportunidades-R3, preservada para recuperação. Não há migração de esquema, alteração de identidade do aplicativo, chave pública ou mecanismo de licença.

## Enviar campanha agora
Em Campanhas, clique em **Enviar campanha agora**, confira a prévia e confirme. Uma rodada é solicitada imediatamente, dentro dos dias, horários e limites permitidos. O botão não ignora licença, conexão, parada geral, autorização de grupos ou limites diários. Se já houver uma execução em andamento, aguarde e tente novamente; não há duas rodadas simultâneas.

O intervalo passa a ser contado desde o início dessa rodada. Exemplo: envio imediato às 14h07 com intervalo de dez minutos agenda as próximas rodadas às 14h17, 14h27 etc. Se a rodada durar mais do que o intervalo, os horários perdidos são pulados, sem acúmulo e sem deslocar toda a sequência. A mesma solicitação confirmada não cria outra rodada quando repetida por falha de rede.

## Iniciar normalmente
Ao ativar uma campanha, o início autorizado estabelece a contagem do intervalo. Se você ativar antes da janela permitida, a referência é a primeira abertura permitida. A retomada de uma campanha já iniciada mantém sua referência e os controles de progresso; use o botão imediato quando quiser iniciar uma rodada e redefinir a contagem. Recuperação por erro, suspensão e reinício continuam aguardando o próximo horário, sem disparar uma rodada acumulada ao reabrir.

A tabela mostra o horário usado como referência em **Intervalo contado desde**. Horários e dias seguem o relógio/fuso do computador. Mudar a janela ou o intervalo exige rever a configuração.

## Oportunidades sem verificar estoque
Use os anúncios das campanhas selecionadas. Esse modo não consulta estoque nem exige confirmar disponibilidade periodicamente. Se sua configuração antiga ainda exigir confirmação por prazo, abra a oportunidade e clique em **Usar anúncios da campanha sem verificar estoque**. A alteração requer permissão de gerenciar Oportunidades, preserva os limites e não liga o automático nem envia mensagens sozinha.

Selecione o anúncio compatível, confira a prévia e envie ao interessado identificado. Continue retirando anúncios que não possa oferecer. Itens removidos/retirados/indisponíveis, modelos incompatíveis, pedidos vencidos, contatos silenciados, duplicidades e envios incertos continuam protegidos. A aceitação da integração não comprova entrega.

## Atualização e recuperação
Pause as automações, crie o backup em Configurações e feche o aplicativo pela bandeja. Copie também o perfil completo `%APPDATA%\Mega Disparos` com o aplicativo fechado, mantendo a identidade de licença local. Instale o novo .exe na mesma pasta dedicada. Não apague o banco, a sessão ou os dados de licença.

A revisão R3 fica em Antigos/Kenned Code Disparos no Drive. Para recuperar, encerre a R4, guarde outra cópia atual do perfil e reinstale a revisão anterior. Não restaure um banco antigo sem conferir os envios posteriores: mensagens já recebidas não são desfeitas e não devem ser duplicadas. Backups comuns não transferem a sessão nem a identidade de licença para outro computador.

## Limitações de validação
Baileys é uma integração não oficial. O envio depende do aplicativo e do computador ligados, internet e sessão conectada. Testes com SQLite, fila e transporte controlado não demonstram recebimento real no WhatsApp. A entrega informa separadamente o que foi testado e as validações pendentes no celular autorizado e no Windows físico.
