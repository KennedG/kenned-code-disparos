# Kenned Code Disparos 2.3.2 — Privado R8

Esta revisão usa a versão vigente Oportunidades Automático R7 como base. Mantém o identificador do aplicativo, o perfil de dados, as licenças, as campanhas e as demais funções. Não acrescenta estoque, vendas, financeiro ou inteligência artificial. Não inclui a preparação experimental R6.

## O que foi corrigido

O diagnóstico enviado pelo usuário comprova tentativas de alerta interrompidas antes do envio com `WA_RECIPIENT_MISMATCH`: o cadastro tinha 13 dígitos e a conta retornada pelo WhatsApp tinha 12. O usuário confirmou que o número cadastrado era seu; a conclusão anterior de que o destinatário estava errado foi retirada.

Agora uma variação brasileira com o nono dígito só é vinculada quando duas consultas autenticadas, uma para cada numeração, retornam exatamente uma conta canônica e o mesmo LID. A semelhança entre números apenas seleciona o caso que deve ser verificado; não autoriza ninguém. Se faltar essa prova, houver conflito, mais de um resultado, mudança de sessão ou timeout, o envio continua bloqueado com diagnóstico. Nenhum dígito é retirado por suposição e nenhum cadastro é regravado.

Os comandos usam o telefone efetivamente recebido e respondem ao chat privado autenticado. A autorização central considera apenas vínculos comprovados pela sessão atual, exige um único usuário ativo e mantém as permissões existentes. Dois usuários que se tornem candidatos para a mesma conta causam bloqueio por ambiguidade. O vínculo de transporte tem prazo e precisa ser verificado novamente após reiniciar ou reconectar.

Os comandos curtos agora aparecem no rastreamento do transporte. As etapas do controlador de Oportunidades usam o mesmo identificador de rastreamento da mensagem recebida. A exportação registra versão, revisão e plataforma. A revisão também aparece no aplicativo e em Sobre.

Os controles persistentes de comandos reconhecem o mesmo usuário e identificador de mensagem mesmo se a rota mudar entre telefone e LID. Isso não altera o destinatário real da resposta. Os registros anteriores continuam reconhecidos.

## Atualizar e configurar

1. Na versão atual, faça um backup em Configurações. Guarde a cópia fora da pasta do instalador. Não desinstale apagando os dados.
2. Feche o aplicativo, inclusive na bandeja, e execute `Kenned-Code-Disparos-Setup-2.3.2-Privado-R8-x64.exe`. Use a instalação existente. O perfil continua em `%APPDATA%\Mega Disparos`; não apague essa pasta nem a sessão protegida pelo Windows.
3. Abra e confira **2.3.2 · R8** na identificação da versão. Esta revisão não muda o esquema do banco nem redefine campanhas, responsáveis, telefones, modo automático, permissões ou chaves de licença.
4. Em Usuários, confira se o número particular completo, com país e DDD, pertence a um único usuário ativo. Para Oportunidades, o usuário precisa gerenciar e responder oportunidades e controlar automações.
5. Em Oportunidades, mantenha esse número em **WhatsApp particular do administrador**. Os anúncios continuam indo somente para os destinos cadastrados da campanha selecionada. Os avisos e comandos do administrador usam o particular configurado.
6. Confira os destinatários em Alertas e nas campanhas. Donos ativos com telefone cadastrado também podem receber alertas, conforme a política existente. Não é preciso trocar um número correto apenas porque ele também é o contato do desenvolvedor.
7. Conecte o WhatsApp normalmente. Do particular autorizado, envie uma mensagem nova `!status` para o número conectado da loja. Depois use **Enviar alerta de teste**, exclusivamente para esse particular. Mensagens antigas ou ainda sem conteúdo decifrado não executam comandos.

## Comandos preservados

- `!status` e `!ajuda`: situação e ajuda de Oportunidades.
- `!automatico on`: liga o modo automático e representa retomada explícita das novas automações após uma parada geral; não recria tarefas canceladas nem inicia campanhas antigas.
- `!automatico off`: avisa e aguarda decisão para oportunidades automáticas ainda não aprovadas.
- `!aprovar ID` e `!recusar ID`: autorizam ou cancelam a oportunidade identificada.
- `!pausar`: interrompe os envios pendentes e bloqueia novas automações. Um envio já submetido pode concluir; seu resultado é registrado.
- `!mega ajuda`, `!mega menu`, `!mega status` e `!mega parar tudo`: mantêm o controle administrativo existente e exigem as permissões correspondentes.
- `!busca iPhone 15 Pro Max 256GB`: busca no particular habilitado, com os filtros e permissões configurados.
- `!busca`: orientação de uso.
- `!busca --excel iPhone 15 Pro Max 256GB` e `!busca --ambos iPhone 15 Pro Max 256GB`: preservam os formatos já existentes. O prefixo configurado continua valendo.

A atualização não ativa BUSCAS, conversas privadas ou grupos que estejam desabilitados. Um número autorizado somente a pesquisar não recebe permissão administrativa. Comandos encaminhados, automáticos, de grupos ou com identidade insegura continuam recusados conforme a função.

## Como conferir o resultado

No Diagnóstico, acompanhe a mesma operação desde o recebimento até a autorização, execução e resposta. `WA_RECIPIENT_IDENTITY_CONFIRMED` comprova a resolução da conta, não o envio. `WA_SERVER_ACCEPTED` comprova aceitação pela integração, não entrega no celular. Entrega depende do recibo posterior; recebimento no aparelho de teste deve ser conferido pelo usuário.

Pendências antigas com resultado incerto não são repetidas automaticamente. Alertas antigos já marcados com falha não são reenviados em massa ao atualizar. Use o teste ou uma tentativa manual controlada depois de revisar o destinatário e o resultado anterior.

## Recuperação

O instalador R7 anterior fica preservado em Antigos no Drive. Para voltar, feche o aplicativo e instale essa revisão sem apagar o perfil. A R8 não exige migração de esquema. Antes de restaurar um backup antigo, preserve também os dados atuais: ele pode não conter mensagens aceitas depois da cópia. Mantenha os envios pausados e confira o controle de duplicidade antes de retomar. Não substitua um banco aberto ou apague resultados incertos para forçar reenvio.

## Limitações e validações pendentes

Baileys é uma integração não oficial. A identificação depende das informações que a sessão e os servidores disponibilizarem. Se o WhatsApp não fornecer as duas provas de identidade exigidas, esta revisão não libera o envio por semelhança de telefone. O diagnóstico mostra a etapa e a falha para revisão.

O arquivo analisado também continha mensagens sem conteúdo decifrado, equivalentes a “Aguardando mensagem”. Não é possível recuperar ou interpretar esse conteúdo por uma regra de telefone, nem concluir que eram comandos. O aplicativo mantém o tratamento suportado pela integração e não promete decifração de conteúdo indisponível.

Os testes automatizados e os sockets controlados não comprovam aceitação por uma conexão real, entrega ou recebimento no celular. Não há sessão real do usuário ou Windows físico disponível neste ambiente de desenvolvimento. A conexão real, a disponibilidade da prova de LID, a recepção dos comandos, os alertas no particular e a instalação no Windows precisam ser validados no computador do usuário. Nenhum teste é enviado a clientes ou grupos de produção.
