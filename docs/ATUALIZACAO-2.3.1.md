# Atualização e recuperação — Kenned Code Disparos 2.3.1

Esta atualização usa exclusivamente o código verificado da versão **2.3.0**, na linha 2.3. Não inclui vendas, estoque comercial, caixa, financeiro, custos, margens, relatórios financeiros ou uma nova comparação automática de ofertas equivalentes.

**Situação da validação real:** a versão é uma candidata à validação no WhatsApp do usuário. Não havia sessão da loja conectada nem número particular de teste identificado neste ambiente. Testes automatizados e com transporte controlado não comprovam recebimento em um celular. Instalação, notificações e áudio no Windows do usuário também exigem validação nesse equipamento. Consulte o relatório de testes da entrega para as verificações efetivamente executadas.

## Atualizar com segurança

1. Suspenda as campanhas e lembretes que não devem enviar durante a atualização. Encerre o aplicativo pela bandeja, escolhendo **Encerrar**; apenas fechar a janela pode mantê-lo funcionando.
2. No Explorador de Arquivos, abra `%APPDATA%\Mega Disparos` e copie **a pasta inteira**, com o aplicativo encerrado, para um local privado. Identifique a cópia com a data e a versão 2.3.0. Não apague a pasta original.
3. Guarde o instalador anterior `Kenned-Code-Disparos-Setup-2.3.0-x64.exe` e execute `Kenned-Code-Disparos-Setup-2.3.1-x64.exe`, usando a mesma pasta de instalação. O uso diário dispensa terminal e ambiente de desenvolvimento.
4. Abra o aplicativo, confira a versão, entre com o usuário existente e verifique campanhas, contatos, modelos, mídias, lembretes, responsáveis, autorizações e preferências de BUSCAS antes de reativar envios.
5. Confirme que o modo escolhido é o real. Selecione somente grupos reais obtidos da conta e conecte/reconecte o WhatsApp quando necessário. Um estado vazio ou erro de conexão não é preenchido com grupos fictícios.

A pasta continua chamada `%APPDATA%\Mega Disparos` para preservar o perfil anterior; o nome exibido é **Kenned Code Disparos**. O identificador `br.com.megadisparos.desktop` e a proteção de credenciais permanecem compatíveis. Não crie outro perfil nem copie somente o executável.

## Quais backups preservam o quê

| Cópia | Conteúdo e uso |
|---|---|
| Pasta inteira do perfil, com o aplicativo encerrado | Recuperação completa do estado local: banco, mídias, configurações, usuários, autorizações, progresso operacional e arquivos cifrados de sessão. Mantenha a cópia privada. |
| `backups\antes-atualizacao-2.3.1-….sqlite` | Cópia consistente e verificada do banco, criada antes de alterar um banco existente nessa atualização. Inclui cadastros e controle operacional, mas **não** copia os arquivos de mídia nem os arquivos separados de sessão. |
| Backup comum `.mega.json`, pela interface | Backup portátil de campanhas, grupos, modelos, contatos, destinatários, configurações exportáveis, mídias e configuração de lembretes. **Não substitui** o backup do perfil: não leva usuários, permissões, senhas, sessão, credenciais, históricos, ledgers de envio nem dados/configurações/autorizações de BUSCAS. |

A cópia SQLite mantém o esquema 7 e é criada antes das alterações locais da atualização; a abertura é interrompida se sua verificação falhar. A proteção DPAPI dos arquivos de sessão depende do Windows. Para recuperar credenciais, utilize o computador e o usuário Windows originais; copiar esses arquivos para outra conta ou computador não garante decriptação. Se necessário, conecte novamente por QR code. Não envie backups privados como evidência de diagnóstico.

## Recuperar a versão anterior

1. Encerre completamente a 2.3.1 e faça outra cópia privada do perfil atual, para preservar alterações e resultados posteriores à atualização.
2. Reinstale a 2.3.0 na pasta dedicada do aplicativo. Não execute a versão antiga enquanto o perfil estiver sendo restaurado.
3. Restaure **a pasta inteira** copiada antes da atualização, no mesmo caminho e com o aplicativo encerrado. Preserve a cópia atual fora desse caminho; não misture arquivos de bancos e sessões de momentos diferentes.
4. Abra a 2.3.0 e mantenha os envios pausados. Antes de retomar, revise os envios confirmados após a data do backup: restaurar um estado anterior também restaura o controle de duplicidade daquele momento e pode esquecer confirmações posteriores.

Se só existir o snapshot SQLite, guarde o perfil atual, restaure o snapshot como `mega.sqlite` com o aplicativo encerrado e retire os arquivos antigos `mega.sqlite-wal`/`mega.sqlite-shm` do perfil ativo. Os arquivos de mídia e a sessão correspondente precisam existir separadamente. Essa recuperação parcial exige revisão antes de enviar; prefira a cópia completa do perfil.

## Preparar o teste pelo seu particular

Use somente o **número particular autorizado do dono**, com código do país e DDD. Se esse número não estiver identificado, forneça apenas esse dado; não use outro contato por suposição. Nunca faça os testes em clientes ou grupos de produção.

1. Em **Usuários**, vincule o número particular a um usuário ativo. Para pesquisar, conceda a permissão de pesquisa e a autorização explícita de BUSCAS. Para `!mega`, conceda separadamente as permissões administrativas e vincule o número ao controle autorizado em Configurações. Nome de exibição não concede acesso.
2. Em **BUSCAS → Configurações**, ative o módulo e a aceitação de comandos privados. Se houver uma lista restrita de conversas privadas, inclua o número particular nela. Configurações antigas de bloqueio são preservadas e precisam ser revistas.
3. Selecione grupos de teste reais para captura. Os grupos monitorados e os locais que aceitam comandos são configurações separadas. As ofertas precisam ter sido efetivamente capturadas; o histórico pode conter lacunas.
4. Em **Alertas**, confira o destinatário ativo com país e DDD e use **Enviar alerta de teste**. A entrada na fila não comprova envio.
5. Do particular, envie ao privado do número da loja os comandos abaixo. A resposta de busca deve voltar somente ao mesmo particular, independentemente dos responsáveis escolhidos para listas manuais.

```text
!busca iPhone 15 Pro Max 256GB
!busca
!busca --excel iPhone 15 Pro Max 256GB
!busca --ambos iPhone 15 Pro Max 256GB
!mega ajuda
!mega menu
!mega status
```

Teste também uma consulta sem resultados e a recusa de um remetente não autorizado. Execute `!mega parar tudo` somente em ambiente controlado: ele bloqueia novas filas automáticas, incluindo respostas de BUSCAS, listas, alertas e lembretes. Os comandos administrativos continuam disponíveis. Para reabrir as filas, use `!mega retomar sistema`; reative individualmente as campanhas e lembretes desejados. Um envio que já chegou à integração pode não ser cancelável e deve aparecer no resultado da parada.

## Acompanhar a evidência

Em **Diagnóstico**, acompanhe o identificador de rastreamento da operação e a sequência recebimento, autorização, processamento, fila e resultado. Consulte também o estado individual em BUSCAS ou Alertas.

- **Pendente / processando:** ainda não há aceitação confirmada.
- **Enviado — aceito pela integração:** o envio foi aceito; não comprova recebimento no celular.
- **Entregue / lido:** exige o recibo correspondente, quando a integração o disponibilizar.
- **Falhou:** veja o código e o motivo; uma nova tentativa só é segura nas condições indicadas.
- **Resultado incerto:** confira no WhatsApp antes de repetir. Não há reenvio automático de um resultado incerto.

Registre separadamente aceitação real, recibo de entrega e recebimento confirmado no celular. Se o comando não aparecer no diagnóstico, a investigação começa no recebimento; se aparecer, use a última etapa e o erro específico. Copie/exporte os detalhes pelo aplicativo, sem credenciais.

Na desconexão, o aviso local ocorre imediatamente e o alerta privado permanece pendente para reconexão, preservando o horário original. Notificações e som dependem do aplicativo em execução, permissões, volume e mudo do Windows. Agendamentos precisam do computador ligado, conectado à internet e sem suspensão.

A integração Baileys é **não oficial**. PN/LID, histórico, grupos/comunidades, edições, exclusões e recibos dependem dos eventos disponibilizados. Ausência de identidade confiável bloqueia a autorização; não gera um telefone fictício nem troca silenciosamente o destino. Consulte [Comandos e Excel](COMANDOS-EXCEL-2.3.1.md) e [limitações da integração](INTEGRACAO.md).

## Respostas pendentes da versão anterior

A 2.3.0 usava uma prova de conversa assinada por uma chave apenas em memória. Uma resposta privada ainda pendente daquele processo pode ser recusada na atualização com `WA_REPLY_CONTEXT_INVALID`: o aplicativo não tenta adivinhar outro destino. Verifique se a resposta já chegou e envie um novo comando do mesmo particular. A 2.3.1 guarda a chave dessa prova dentro da sessão cifrada do Windows; os testes controlados verificaram a recuperação de novas respostas pendentes após reinicializar, sem duplicação. Remover a sessão ou trocar de conta invalida provas anteriores e exige novo comando.
