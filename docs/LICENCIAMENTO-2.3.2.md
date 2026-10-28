# Licenciamento — Kenned Code Disparos 2.3.2

Esta versão mantém a linha 2.3 baseada no código verificado da 2.3.0, sem módulos de vendas, caixa ou financeiro. O licenciamento controla o direito de executar operações; não substitui usuários, permissões de BUSCAS e administração, nem altera o destinatário das respostas privadas. Na revisão **reformulado-r1**, vencimento confirmado permite somente ativação/verificação da licença e contato com o desenvolvedor; essa regra substitui a antiga disponibilidade de consulta e exportação depois de vencer.

## Como funciona para o cliente

1. Instale o aplicativo e abra com acesso à internet. O primeiro registro do dispositivo inicia automaticamente um teste de **72 horas**, sem chave ou aprovação do distribuidor. O horário utilizado é o do serviço de licenciamento.
2. Consulte a aba **Licença** para ver o plano, o estado, o tempo restante e o vencimento exato. A validação inicial requer internet: o aplicativo não cria um teste local independente quando o serviço estiver indisponível.
3. Para continuar após o teste, cole a chave recebida em **Ativar licença** e clique em **Ativar**. A primeira ativação bem-sucedida inicia o período pago inteiro; o teste restante não é descontado.
4. Para renovar, use uma nova chave. Antes de vencer, o novo período começa no vencimento atual; depois de vencer, começa no horário da renovação. Repetir a mesma chave não acrescenta prazo novamente.
5. Depois de renovar, revise e retome explicitamente os envios que deseja executar. Campanhas antigas não são retomadas automaticamente.

Uma chave mensal acrescenta **um mês de calendário** e uma anual acrescenta **um ano de calendário**, no calendário de Brasília, `America/Sao_Paulo`, conforme o horário confiável do serviço. Quando o dia não existe no destino, utiliza-se o último dia válido: por exemplo, 31 de janeiro mais um mês termina em 28 de fevereiro, ou 29 em ano bissexto; 29 de fevereiro mais um ano termina em 28 de fevereiro. O servidor registra o instante exato e o aplicativo o apresenta no fuso configurado.

## Internet, expiração e dados preservados

A primeira ativação exige contato seguro com o serviço. Após uma validação bem-sucedida, um comprovante assinado permite até **72 horas** sem novo contato, limitado também ao vencimento do teste ou da licença. A tolerância não adiciona dias ao contrato. Falha de internet e resposta negativa do servidor têm estados diferentes.

Quando a validade não puder ser comprovada com segurança, o aplicativo bloqueia novos envios e automações. Ao confirmar o vencimento do teste ou da licença, bloqueia também consulta, edição, exportação e demais recursos: ficam disponíveis somente a tela de licença e o botão de contato com o desenvolvedor. Os registros, contatos, campanhas, modelos, arquivos, lembretes, usuários, responsáveis e controle operacional continuam armazenados. A TV deixa de exibir ofertas enquanto bloqueada. O botão de suporte abre a conversa externa com o desenvolvedor mediante clique; não envia uma mensagem automaticamente nem libera o aplicativo. Um envio já submetido ao WhatsApp pode não ser cancelável; seu resultado deve ser revisado antes de repetir após renovar.

Não altere o relógio do Windows para prolongar o período. O aplicativo confere o horário de servidor e checkpoints locais protegidos; uma regressão relevante de relógio exige nova validação online. Suspensão e reinicialização não criam uma nova tolerância. Reabrir o aplicativo no mesmo ciclo do Windows pode usar o comprovante offline válido. Após reiniciar o próprio Windows, é exigida validação online, porque o contador de tempo do sistema foi reiniciado; isso impede ampliar a tolerância congelando o relógio enquanto o computador está desligado. As automações também precisam do computador ligado, sem suspensão, e de conexão válida ao WhatsApp.

O controle também compara um marcador independente da inicialização, obtido do log System e de WMI/CIM no Windows. Se não puder lê-lo, a validação online pode liberar o processo atual, mas o cache não libera operações ao reabrir. A ausência desse acesso não cria outro teste nem estende o vencimento.

## Dispositivo, reinstalação e segurança

O teste e as ativações são registrados no servidor por dispositivo, com uma identidade criptográfica local vinculada à instalação protegida do Windows e identificadores estáveis do equipamento. O registro não fica somente na pasta de campanhas. Reinstalar ou apagar os dados comuns do aplicativo não inicia outro teste no mesmo dispositivo.

Cada chave pode ser ativada em um único dispositivo. Uma nova instalação com identidade inconsistente não recebe o período de outra instalação por suposição. Se houver troca de equipamento, perda da identidade protegida ou alteração relevante de hardware, consulte o distribuidor; não copie credenciais de um computador para outro.

Os comprovantes são assinados pelo serviço e verificados com uma chave **pública** incluída no aplicativo. A chave privada de assinatura, as credenciais administrativas e o cadastro completo de chaves não pertencem ao instalador. No serviço, as chaves são cadastradas por hash; os arquivos administrativos contêm o código necessário para distribuí-las e precisam permanecer privados.

Esses controles reduzem reutilização de códigos, reinício indevido do teste e adulteração de comprovantes. Não garantem proteção impossível contra um administrador local que modifique o binário, clone ambientes ou falsifique identificadores de hardware. Alterações de firmware, troca de equipamento, identidades ilegíveis e restaurações antigas podem exigir recuperação assistida; não recebem licença adicional automaticamente.

## Distribuição pelo dono

Use a pasta privada **Kenned Code — Licenças** no Google Drive. Ela deve conter **Mensais — Disponíveis**, **Anuais — Disponíveis**, **Usadas** e a planilha administrativa. Existem arquivos separados para as chaves mensais e anuais; o prazo começa na ativação, não na geração.

1. Escolha uma chave disponível do plano comprado e envie somente esse código ao cliente.
2. Preencha o destinatário e a data de envio na planilha e marque como **enviada**. Se desejar, mova o arquivo para **Usadas** para organizar os códigos distribuídos.
3. Oriente o cliente a abrir **Ativar licença**, colar o código e ativar com internet.
4. Consulte o registro oficial do serviço para distinguir envio, ativação e vencimento. Mover um arquivo, editar a planilha ou colocar uma chave de volta na pasta não ativa, revoga, desvincula nem torna o código reutilizável.

Não compartilhe a pasta administrativa com todos os usuários e não inclua esses arquivos em backups públicos, no código-fonte entregue aos clientes ou no instalador. A planilha administrativa é uma organização da distribuição; o **servidor é a fonte oficial** da ativação e da renovação.

## Atualização e recuperação

Encerre o aplicativo pela bandeja e copie o perfil inteiro `%APPDATA%\Mega Disparos`, incluindo mídias, para um local privado antes de instalar a nova versão. Preserve `%LOCALAPPDATA%\KennedCodeDisparos-Licensing` e a âncora `HKCU\Software\KennedCodeDisparos\Licensing` no mesmo dispositivo. O identificador legado e a pasta do perfil são mantidos para preservar dados. Credenciais protegidas por DPAPI permanecem vinculadas ao usuário e equipamento Windows correspondentes; não são portáteis para outro computador. Confira cadastros e controles operacionais antes de retomar os envios. Consulte [Atualização e recuperação desta revisão](ATUALIZACAO-2.3.2-REFORMULADO.md).

O backup das campanhas não transfere uma licença para outro computador. Reinstalar a mesma versão ou restaurar dados não reinicia o teste nem aumenta o contrato no servidor. Para recuperar a versão anterior, preserve primeiro o perfil atual, reinstale o instalador guardado e restaure a cópia completa anterior, com os envios pausados. Confirmações de envio posteriores ao backup precisam ser revisadas para evitar repetição.

## Serviço hospedado e operação

O servidor utiliza HTTPS, registro persistente de dispositivos e licenças, horário de servidor, comprovantes assinados e operações atômicas para impedir duas ativações conflitantes. O dono não precisa deixar seu computador ligado nem aprovar cada cliente. A hospedagem, o banco e seus limites precisam continuar ativos; essa dependência é diferente da conexão WhatsApp do cliente.

As instruções e evidências de publicação, as verificações efetivamente executadas e as pendências estão em [Validação do licenciamento](VALIDACAO-LICENCA-2.3.2.md). Não interprete um teste local, uma tela de sucesso ou um código gerado como prova de cadastro em produção. O responsável deve conservar os procedimentos de recuperação do banco hospedado e das credenciais privadas. Custos e limites dependem da hospedagem utilizada; não há promessa de gratuidade permanente.


O serviço está publicado em https://kenned-code-licencas.guilhermekenned.chatgpt.site, com Worker hospedado e banco D1 persistente. Nenhum computador pessoal precisa ficar ligado para ativar. Sites/Cloudflare precisam permanecer disponíveis; preços, cotas e SLA dependem do plano da hospedagem. Nenhuma contratação externa de servidor pago foi feita nesta execução.
