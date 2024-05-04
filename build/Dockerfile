FROM node:21.7.3 as builder

# build wizard
WORKDIR /usr/src/app/wizard
COPY wizard .
RUN yarn
RUN rm -Rf build && yarn build --production

# Monitor
WORKDIR /usr/src/monitor
COPY monitor .
RUN yarn --production


####### Main image

FROM --platform=linux/amd64 node:21.7.3
ARG RP_VERSION

RUN mkdir -p /srv/rocketpool

RUN wget "https://github.com/rocket-pool/smartnode-install/releases/download/${RP_VERSION}/rocketpool-cli-linux-amd64" -O /usr/local/bin/rocketpool
RUN wget "https://github.com/rocket-pool/smartnode-install/releases/download/${RP_VERSION}/rocketpool-daemon-linux-amd64" -O /usr/local/bin/rocketpoold

RUN chmod +x /usr/local/bin/rocketpool /usr/local/bin/rocketpoold

RUN apt-get -y update && apt-get -y upgrade && apt-get -y install \
    gettext\
    jq \
    nginx \
    sudo \
    supervisor \
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -s /bin/false nginx

COPY --from=builder /usr/src/app/wizard/build /usr/local/wizard
COPY --from=builder /usr/src/monitor /usr/src/monitor

COPY startRpNode.sh /srv/rocketpool
COPY restart-validator.sh /srv/rocketpool
RUN chmod a+x /srv/rocketpool/startRpNode.sh /srv/rocketpool/restart-validator.sh
RUN ln -sf /srv/rocketpool/restart-validator.sh /srv/rocketpool/stop-validator.sh
COPY user-settings.template /srv/rocketpool
COPY settings.template /srv/rocketpool

COPY supervisord.conf /etc/supervisord.conf
COPY nginx.conf /etc/nginx/

# For testing
RUN echo 'alias rp="rocketpool --daemon-path /usr/local/bin/rocketpoold --config-path /srv/rocketpool --allow-root"' >> ~/.bashrc
RUN echo 'alias rpd="rocketpoold --settings /srv/rocketpool/user-settings.yml api"' >> ~/.bashrc

# TODO?
# RUN useradd nginx

WORKDIR /
ENTRYPOINT ["supervisord", "--nodaemon", "--configuration", "/etc/supervisord.conf"]


